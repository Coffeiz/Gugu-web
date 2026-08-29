#!/usr/bin/env python3
"""对比普通滚动压缩与分支式压缩。

脚本只读取现有 session 的 snapshot/history，不调用生产压缩入口，也不写入
ConversationSession 或 ConversationMessage。普通策略复用当前的分块滚动语义；
分支策略在独立 provider 请求中一次性压缩可压缩 history，模拟“从当前 session
上下文分支出压缩任务，完成后再 CAS 提交 baseline”的候选实现。

输出只包含脱敏摘要：长度、哈希、usage/cache、结构覆盖和盲评结果，不输出对话正文。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from agent.context.compress_conv import (  # noqa: E402
    _MAX_COMPRESS_CHARS,
    _RECENT_HISTORY_KEEP_CHARS,
    _PROMPT_PATH,
)
from agent.context.tokens import content_text  # noqa: E402


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def usage_values(usage: Any) -> dict[str, int | float]:
    def value(*names: str) -> int:
        for name in names:
            result = getattr(usage, name, None)
            if result is not None:
                return int(result or 0)
        return 0

    fresh = value("input_tokens", "prompt_tokens")
    cache_read = value("cache_read_input_tokens", "prompt_cache_hit_tokens")
    cache_write = value("cache_creation_input_tokens", "prompt_cache_creation_tokens")
    total = fresh + cache_read
    return {
        "provider_fresh_input_tokens": fresh,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "total_input_tokens": total,
        "cache_ratio": round(cache_read / total * 100, 2) if total else 0,
    }


def split_history(rows: list[Any], baseline_id: int, keep_chars: int) -> tuple[list[Any], list[Any]]:
    active = [row for row in rows if row.role != "summary" and row.id > baseline_id]
    tail: list[Any] = []
    chars = 0
    for row in reversed(active):
        raw = row.content_json if row.content_json is not None else row.content
        size = len(content_text(raw).strip())
        if tail and chars + size > keep_chars:
            break
        tail.append(row)
        chars += size
    tail.reverse()
    tail_ids = {row.id for row in tail}
    return [row for row in active if row.id not in tail_ids], tail


def text_lines(rows: list[Any]) -> list[str]:
    result: list[str] = []
    for row in rows:
        raw = row.content_json if row.content_json is not None else row.content
        text = content_text(raw).strip()
        if text:
            role = "用户" if row.role == "user" else "咕咕"
            result.append(f"{role}：{text}")
    return result


def chunks(lines: list[str], limit: int) -> list[str]:
    result: list[list[str]] = [[]]
    size = 0
    for line in lines:
        if result[-1] and size + len(line) > limit:
            result.append([])
            size = 0
        result[-1].append(line)
        size += len(line)
    return ["\n\n".join(chunk) for chunk in result if chunk]


def prompt_text() -> str:
    try:
        return _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return "请保留对话中的决定、事实、偏好和待办，输出简洁摘要。"


def build_user_text(history_text: str, previous_summary: str | None) -> str:
    if not previous_summary:
        return history_text
    return (
        f"【已有摘要（更早的对话，需与下面新增内容合并、保留全部关键信息）】\n"
        f"{previous_summary}\n\n【新增对话】\n{history_text}"
    )


async def call_text(settings, system: str, user: str, max_tokens: int = 800) -> tuple[str, dict]:
    import httpx
    from agent import providers
    from agent.llm.llm_select import use_anthropic_for

    ai = settings.ai
    timeout = httpx.Timeout(connect=15.0, read=180.0, write=15.0, pool=15.0)
    started = time.perf_counter()
    if use_anthropic_for(ai):
        client = providers.build_anthropic_client(ai, timeout)
        try:
            response = await client.messages.create(
                model=ai.model,
                system=system,
                messages=[{"role": "user", "content": user}],
                max_tokens=max_tokens,
                temperature=0.2,
            )
            text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
        finally:
            await client.close()
    else:
        client = providers.build_openai_client(ai, timeout)
        try:
            response = await client.chat.completions.create(
                model=ai.model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                max_tokens=max_tokens,
                temperature=0.2,
            )
            text = response.choices[0].message.content or ""
        finally:
            await client.close()
    usage = usage_values(getattr(response, "usage", None))
    usage["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return text.strip(), usage


async def load_session(session_id: int):
    from sqlalchemy import select
    import app.db.session as db_session
    from app.models import ConversationMessage, ConversationSession

    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        session = await db.get(ConversationSession, session_id)
        if session is None:
            raise RuntimeError(f"找不到 session={session_id}")
        rows = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id)
            .order_by(ConversationMessage.id.asc())
        )).scalars().all()
        return session, rows


def quality_shape(summary: str, source_lines: list[str]) -> dict[str, int | str]:
    source_text = "\n".join(source_lines)
    summary_tokens = set(summary.replace("，", " ").replace("。", " ").split())
    source_tokens = {token for token in source_text.replace("，", " ").replace("。", " ").split() if len(token) > 1}
    overlap = len(summary_tokens & source_tokens)
    return {
        "chars": len(summary),
        "digest": digest(summary),
        "source_nonempty_lines": len(source_lines),
        "lexical_overlap_tokens": overlap,
    }


async def blind_judge(settings, source_text: str, ordinary: str, branch: str) -> dict:
    system = (
        "你是摘要质量评审器。只输出 JSON，不要输出 Markdown。字段必须是："
        "ordinary_score、branch_score、ordinary_coverage、branch_coverage、"
        "ordinary_accuracy、branch_accuracy、winner、reason。分数为 0 到 10 的整数；"
        "coverage/accuracy 分别评估关键信息覆盖与是否臆造。"
    )
    user = (
        "原始对话：\n" + source_text + "\n\n"
        "摘要 A：\n" + ordinary + "\n\n摘要 B：\n" + branch
    )
    text, usage = await call_text(settings, system, user, max_tokens=300)
    try:
        start, end = text.find("{"), text.rfind("}")
        result = json.loads(text[start:end + 1]) if start >= 0 and end > start else {}
    except (ValueError, json.JSONDecodeError):
        result = {}
    return {"scores": result, "usage": usage}


async def run(args) -> int:
    from app.core.config import get_settings

    settings = get_settings()
    session, rows = await load_session(args.session_id)
    baseline_id = int(getattr(session, "baseline_message_id", 0) or 0)
    compressible, tail = split_history(rows, baseline_id, _RECENT_HISTORY_KEEP_CHARS)
    source_lines = text_lines(compressible)
    if not source_lines:
        raise RuntimeError("该 session 没有可压缩 history")
    previous_summary = next((row.content for row in rows if row.role == "summary"), None)
    system = prompt_text()

    warmup = None
    if not args.no_warmup:
        # 先完成一轮独立的只读对话请求，预热 provider 连接/模型和稳定前缀。
        # 该请求不写入 session；压缩请求使用自己的摘要 system prompt，不能把
        # 这次 warmup 的 cache 命中误算成压缩策略收益，所以单独报告。
        snapshot_system = str((session.session_context or {}).get("system_prompt") or "")
        if not snapshot_system:
            raise RuntimeError("目标 session 缺少 system snapshot，无法进行对话预热")
        _, warmup_usage = await call_text(
            settings,
            snapshot_system,
            "这是压缩对比测试前的预热轮次。请只回复：预热完成。",
            32,
        )
        warmup = {"mode": "readonly_conversation", "usage": warmup_usage}

    ordinary = ""
    ordinary_calls = []
    for chunk in chunks(source_lines, _MAX_COMPRESS_CHARS):
        ordinary, usage = await call_text(settings, system, build_user_text(chunk, ordinary or previous_summary), 800)
        ordinary_calls.append(usage)
        if not ordinary:
            raise RuntimeError("普通滚动压缩返回空摘要")

    branch_input = build_user_text("\n\n".join(source_lines), previous_summary)
    branch, branch_usage = await call_text(settings, system, branch_input, 800)
    if not branch:
        raise RuntimeError("分支式压缩返回空摘要")

    report = {
        "session": {
            "id": session.id,
            "source": session.source,
            "baseline_message_id": baseline_id,
            "history_rows": len(rows),
            "compressible_rows": len(compressible),
            "kept_tail_rows": len(tail),
            "compressible_chars": sum(len(line) for line in source_lines),
            "snapshot_present": bool(session.session_context),
            "snapshot_not_compressed": True,
        },
        "strategy": {
            "ordinary": {
                "calls": len(ordinary_calls),
                "usage": ordinary_calls,
                "summary": quality_shape(ordinary, source_lines),
            },
            "branch": {
                "calls": 1,
                "usage": branch_usage,
                "summary": quality_shape(branch, source_lines),
            },
        },
    }
    report["warmup"] = warmup or {"mode": "disabled"}
    if args.judge:
        report["blind_judge"] = await blind_judge(settings, "\n".join(source_lines), ordinary, branch)
    if args.include_summaries:
        # 仅用于本地人工复核，默认不写入报告，避免诊断产物携带用户对话内容。
        report["private_summaries"] = {
            "ordinary": ordinary,
            "branch": branch,
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="普通压缩与分支式压缩只读对比")
    parser.add_argument("--session-id", type=int, required=True)
    parser.add_argument("--judge", action="store_true", help="额外调用一次盲评，不输出摘要正文")
    parser.add_argument("--include-summaries", action="store_true", help="仅人工复核时写入摘要正文，默认关闭")
    parser.add_argument("--no-warmup", action="store_true", help="跳过压缩前的只读对话预热轮次")
    parser.add_argument("--output", help="写入脱敏 JSON 报告")
    raise SystemExit(asyncio.run(run(parser.parse_args())))


if __name__ == "__main__":
    main()
