#!/usr/bin/env python3
"""用真实 session 上下文对比 reminder role 的缓存与 provider 兼容性。

脚本只输出结构摘要、digest、usage 和错误类型，不输出会话正文、附件名或密钥。
默认从数据库选择最近更新的 session；也可以用 ``--session-id`` 固定测试对象。
每个 provider/role 独立连续执行三轮，避免不同 role 的请求互相污染同一组结果。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


ROLES = ("user", "system", "context")
TEST_MESSAGES = (
    "继续说明刚才的问题。",
    "把原因和可能的改进方案整理一下。",
    "最后给一个简短结论。",
)


def digest(value: object) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()[:16]


def is_reminder(message: dict) -> bool:
    content = message.get("content")
    return isinstance(content, str) and content.startswith("[system-reminder]")


def change_reminder_role(messages: list[dict], role: str) -> list[dict]:
    changed = []
    for message in messages:
        item = dict(message)
        if is_reminder(item):
            item["role"] = role
        changed.append(item)
    return changed


def shape(messages: list[dict]) -> dict:
    first_reminder = next((i for i, m in enumerate(messages) if is_reminder(m)), None)
    return {
        "message_count": len(messages),
        "reminder_count": sum(is_reminder(m) for m in messages),
        "first_reminder_index": first_reminder,
        "role_counts": {
            role: sum(m.get("role") == role for m in messages)
            for role in ("system", "user", "assistant", "tool", "context")
        },
        "message_digest": digest(messages),
    }


def usage_values(usage) -> dict:
    def value(*names):
        for name in names:
            result = getattr(usage, name, None)
            if result is not None:
                return int(result or 0)
        return 0

    input_tokens = value("input_tokens", "prompt_tokens")
    cache_read = value("cache_read_input_tokens", "prompt_cache_hit_tokens")
    cache_write = value("cache_creation_input_tokens", "prompt_cache_creation_tokens")
    fresh = input_tokens
    return {
        "input_tokens": input_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "fresh_tokens": fresh,
        "cache_ratio": round(cache_read / (cache_read + fresh) * 100, 2)
        if cache_read + fresh else 0,
    }


@dataclass
class Target:
    label: str
    ai: object
    anthropic: bool


async def load_real_context(session_id: int | None, max_messages: int):
    from sqlalchemy import select
    import app.db.session as db_session
    from app.models import ConversationSession
    from agent.context import history as history_context
    from agent.context import session_history, session_snapshot

    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        if session_id is None:
            session = (
                await db.execute(
                    select(ConversationSession)
                    .order_by(ConversationSession.updated_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        else:
            session = await db.get(ConversationSession, session_id)
        if session is None:
            raise RuntimeError("没有找到可测试的 session")

        history = await session_history.load_session_history(
            db, session.id, session_snapshot.history_baseline(session),
            max_messages=max_messages,
        )
        snapshot = session.session_context or {}
        if not snapshot.get("system_prompt"):
            raise RuntimeError("目标 session 没有可复用的 session snapshot")
        request = SimpleNamespace(
            source=session.source,
            chat_id=session.chat_id,
            platform_user_id=session.platform_user_id,
            message=TEST_MESSAGES[0],
            quoted_text=None,
        )
        return session, snapshot, history, request


def targets_from_settings(settings, requested: list[str]) -> list[Target]:
    presets = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    all_targets = [Target("active", settings.ai, False)]
    for index, item in enumerate(presets):
        provider = str(getattr(item, "provider", "") or "").lower()
        if provider in {"minimax", "qwen", "dashscope", "bailian"}:
            all_targets.append(Target(f"{provider}:{index}", item, provider == "minimax"))
    if not requested:
        preferred = [target for target in all_targets if target.ai is not settings.ai]
        return preferred or all_targets[:1]
    selected = []
    for target in all_targets:
        if target.label == "active" and "active" not in requested:
            continue
        if any(
            token in target.label.lower()
            or token in str(getattr(target.ai, "model", "")).lower()
            for token in requested
        ):
            selected.append(target)
    return selected


async def call_anthropic(target: Target, system: str, messages: list[dict]) -> dict:
    import httpx
    from agent import providers

    client = providers.build_anthropic_client(
        target.ai, httpx.Timeout(120.0, connect=15.0, read=120.0, write=15.0, pool=15.0)
    )
    try:
        response = await client.messages.create(
            model=getattr(target.ai, "model", ""),
            max_tokens=160,
            temperature=0.2,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
        )
        return {"ok": True, "usage": usage_values(response.usage)}
    finally:
        await client.close()


async def call_openai(target: Target, system: str, messages: list[dict]) -> dict:
    import httpx
    from agent import providers

    client = providers.build_openai_client(
        target.ai, httpx.Timeout(120.0, connect=15.0, read=120.0, write=15.0, pool=15.0)
    )
    try:
        response = await client.chat.completions.create(
            model=getattr(target.ai, "model", ""),
            max_tokens=160,
            temperature=0.2,
            messages=[{"role": "system", "content": system}] + messages,
        )
        return {"ok": True, "usage": usage_values(response.usage)}
    finally:
        await client.close()


async def run_variant(target: Target, role: str, system: str, base_messages: list[dict]) -> dict:
    messages = change_reminder_role(base_messages, role)
    rounds = []
    for round_index, user_text in enumerate(TEST_MESSAGES, 1):
        current = list(messages)
        current.append({"role": "user", "content": user_text})
        started = time.perf_counter()
        try:
            result = await (
                call_anthropic(target, system, current)
                if target.anthropic else call_openai(target, system, current)
            )
            result.update({
                "round": round_index,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "shape": shape(current),
            })
            rounds.append(result)
            # 不把真实模型输出持久化；只用固定的短 assistant 占位推进真实消息结构。
            messages.append({"role": "assistant", "content": "已完成这一轮整理。"})
        except Exception as exc:
            rounds.append({
                "round": round_index,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "shape": shape(current),
                "ok": False,
                "error_type": type(exc).__name__,
                "error": str(exc)[:240],
            })
            break
    return {"target": target.label, "role": role, "rounds": rounds}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", type=int)
    parser.add_argument("--max-messages", type=int, default=500)
    parser.add_argument("--provider", action="append", default=[])
    args = parser.parse_args()

    from app.core.config import get_settings
    from agent.llm.llm_select import use_anthropic_for

    settings = get_settings()
    session, snapshot, history, request = await load_real_context(
        args.session_id, max(1, args.max_messages)
    )
    targets = targets_from_settings(settings, args.provider)
    if not targets:
        raise RuntimeError("没有找到请求的 MiniMax / 百炼预设")

    from agent.context.history import build_history_parts
    base_history = build_history_parts(
        history, request,
        use_anthropic=use_anthropic_for(targets[0].ai),
        user_tz=None,
    )
    # 只用真实 snapshot 的 system + history；动态尾部也使用正式 reminder 结构。
    from agent.context import session_snapshot
    base_messages = list(base_history)
    base_messages.append(session_snapshot.reminder_message("当前时间：测试运行时"))
    print(json.dumps({
        "session_id": session.id,
        "source": session.source,
        "model_targets": [target.label for target in targets],
        "context": shape(base_messages),
        "snapshot_keys": sorted(snapshot.keys()),
    }, ensure_ascii=False), flush=True)

    for target in targets:
        system = str(snapshot["system_prompt"])
        for role in ROLES:
            # 每个 provider 以自己的协议重新建 history，避免把 Anthropic tool block
            # 直接塞入 OpenAI；本测试只比较 reminder role，业务 history 仍走正式 adapter。
            target_history = build_history_parts(
                history, request,
                use_anthropic=target.anthropic,
                user_tz=None,
            )
            result = await run_variant(target, role, system, target_history + [
                session_snapshot.reminder_message("当前时间：测试运行时")
            ])
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
