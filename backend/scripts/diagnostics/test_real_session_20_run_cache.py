#!/usr/bin/env python3
"""用真实 session 与真实预设测试连续 20 个 run 的跨 call cache。

每个 run 只进行一次 provider 请求，不在脚本内继续执行第二个 provider round。
请求沿用 session snapshot、已持久化 history 和固定 Adapter 工具 schema；如果模型
返回 tool_use，只追加脱敏的诊断 tool_result，下一 run 继续携带这段真实工具历史，
不执行任何业务工具，避免测试修改项目、文件、日历或发送消息。

输出只包含 run 编号、场景、消息结构摘要、工具名、usage、cache ratio 和相邻请求
的首个结构差异位置，不输出 session 正文、模型回复、工具参数、附件名或密钥。
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


SCENARIOS = (
    ("simple-chat", "简单回答：今天适合专注做一件小事吗？"),
    ("project-query", "请查询当前进行中的项目，并按紧急程度给出一句建议。"),
    ("calendar-query", "请查询近期日历安排，只列出最重要的两项。"),
    ("memory-query", "请回顾与当前工作相关的长期记忆，给出一条提醒。"),
    ("complex-planning", "结合项目、日历和记忆，帮我拟一个今天的三步计划。"),
    ("simple-chat", "用一句话说明现在最值得先做什么。"),
    ("web-query", "请查询一个适合南京周末短途出行的公开信息，并简要说明来源。"),
    ("complex-research", "先查资料，再把结论、证据和不确定性分开整理。"),
    ("project-update", "查看项目进展后，指出一个最需要推进的事项。"),
    ("calendar-plan", "根据近期安排，建议一个不冲突的工作时段。"),
    ("simple-chat", "把上一轮的重点压缩成一句话。"),
    ("memory-query", "找一条与当前计划相关的历史信息，并说明关联原因。"),
    ("complex-planning", "综合当前资料设计一个小型执行方案，列出步骤和风险。"),
    ("file-query", "请查看与当前工作相关的文件线索，并告诉我先看哪一个。"),
    ("web-query", "查询一个最新的公开事实，回答时标出需要再次核实的部分。"),
    ("complex-research", "比较两个可行方案，分别说明成本、收益和不确定性。"),
    ("simple-chat", "现在只给我一个简短的行动建议。"),
    ("project-query", "重新检查项目状态，指出相比之前可能变化的地方。"),
    ("complex-planning", "把项目、日历、文件和记忆线索合并成一份简短工作清单。"),
    ("final-summary", "总结这 20 个 run 中已经确认的上下文信息，不要编造工具结果。"),
)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()[:16]


def usage_values(usage: Any) -> dict[str, int | float]:
    def value(*names: str) -> int:
        for name in names:
            result = getattr(usage, name, None)
            if result is not None:
                return int(result or 0)
        return 0

    # Anthropic-compatible MiniMax reports input_tokens as the fresh portion;
    # cache_read_input_tokens is reported separately.  Keep both fields explicit
    # so the ratio never treats the cache block as a second input accidentally.
    fresh = value("input_tokens", "prompt_tokens")
    cache_read = value("cache_read_input_tokens", "prompt_cache_hit_tokens")
    cache_write = value("cache_creation_input_tokens", "prompt_cache_creation_tokens")
    total = fresh + cache_read
    return {
        "input_tokens": total,
        "provider_fresh_input_tokens": fresh,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "fresh_input_tokens": fresh,
        "cache_ratio": round(cache_read / total * 100, 2) if total else 0,
    }


def message_shape(messages: list[dict]) -> dict[str, Any]:
    return {
        "count": len(messages),
        "roles": {
            role: sum(item.get("role") == role for item in messages)
            for role in ("system", "user", "assistant", "tool")
        },
        "digest": digest(messages),
    }


def first_diff(previous: list[dict] | None, current: list[dict]) -> dict[str, Any] | None:
    if previous is None:
        return None
    limit = min(len(previous), len(current))
    for index in range(limit):
        if canonical(previous[index]) != canonical(current[index]):
            return {
                "index": index,
                "previous_role": previous[index].get("role"),
                "current_role": current[index].get("role"),
                "previous_digest": digest(previous[index]),
                "current_digest": digest(current[index]),
            }
    if len(previous) != len(current):
        return {"index": limit, "kind": "length-change", "previous_count": len(previous), "current_count": len(current)}
    return {"index": None, "kind": "identical"}


def serialize_content_block(block: Any) -> dict[str, Any]:
    if hasattr(block, "model_dump"):
        return block.model_dump()
    if isinstance(block, dict):
        return dict(block)
    return {"type": getattr(block, "type", "text"), "text": getattr(block, "text", "")}


def extract_tool_calls(response: Any) -> tuple[list[dict[str, str]], list[dict]]:
    calls: list[dict[str, str]] = []
    blocks: list[dict] = []
    for block in getattr(response, "content", []) or []:
        item = serialize_content_block(block)
        blocks.append(item)
        if item.get("type") == "tool_use":
            calls.append({
                "id": str(item.get("id") or "diagnostic-call"),
                "name": str(item.get("name") or "unknown"),
            })
    return calls, blocks


def append_response_history(messages: list[dict], response: Any, calls: list[dict[str, str]], blocks: list[dict]) -> None:
    if blocks:
        messages.append({"role": "assistant", "content": blocks})
    else:
        messages.append({"role": "assistant", "content": "（本轮没有可持久化的模型输出。）"})
    if calls:
        # 仅用于验证 provider 历史边界，不执行工具；不回显模型传来的参数。
        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": call["id"],
                    "content": json.dumps({"ok": True, "diagnostic": "not_executed"}, ensure_ascii=False),
                }
                for call in calls
            ],
        })


async def load_real_context(session_id: int | None, max_messages: int):
    from sqlalchemy import select
    import app.db.session as db_session
    from agent.context import session_history, session_snapshot
    from app.models import ConversationSession

    db_session.ensure_engine()
    async with db_session._SessionLocal() as db:
        if session_id is None:
            session = (
                await db.execute(
                    select(ConversationSession)
                    .where(ConversationSession.session_context.is_not(None))
                    .order_by(ConversationSession.updated_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        else:
            session = await db.get(ConversationSession, session_id)
        if session is None:
            raise RuntimeError("没有找到可测试的 session")
        history = await session_history.load_session_history(
            db,
            session.id,
            session_snapshot.history_baseline(session),
            max_messages=max_messages,
        )
        snapshot = session.session_context or {}
        if not snapshot.get("system_prompt"):
            raise RuntimeError("目标 session 没有可复用的 session snapshot")
        request = SimpleNamespace(
            source=session.source,
            chat_id=session.chat_id,
            platform_user_id=session.platform_user_id,
            message="诊断测试消息",
            quoted_text=None,
        )
        return session, snapshot, history, request


def select_minimax_m3(settings, requested_model: str | None):
    presets = list(getattr(getattr(settings, "ai_presets", None), "items", None) or [])
    candidates = [
        item for item in presets
        if str(getattr(item, "provider", "") or "").lower() == "minimax"
        and "m3" in str(getattr(item, "model", "") or "").lower()
    ]
    if requested_model:
        candidates = [item for item in candidates if requested_model.lower() in str(getattr(item, "model", "")).lower()]
    if not candidates:
        raise RuntimeError("没有找到 provider=minimax 且模型名包含 M3 的真实预设")
    return candidates[0]


async def call_minimax(ai, system: str, messages: list[dict], tools: list[dict]) -> Any:
    import httpx
    from agent import providers

    client = providers.build_anthropic_client(
        ai,
        httpx.Timeout(180.0, connect=15.0, read=180.0, write=15.0, pool=15.0),
    )
    try:
        from agent.llm.llm_select import supports_anthropic_active_cache

        system_payload: str | list[dict] = system
        if supports_anthropic_active_cache(ai):
            system_payload = [{
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }]
        return await client.messages.create(
            model=getattr(ai, "model", ""),
            max_tokens=min(int(getattr(ai, "max_tokens", 512) or 512), 512),
            temperature=float(getattr(ai, "temperature", 0.2) or 0.2),
            system=system_payload,
            messages=messages,
            tools=tools,
        )
    finally:
        await client.close()


async def run(args) -> int:
    from app.core.config import get_settings
    from agent.context import assembly, session_snapshot
    from agent.context.history import build_history_parts

    settings = get_settings()
    ai = select_minimax_m3(settings, args.model)
    session, snapshot, history, request = await load_real_context(args.session_id, args.max_messages)
    from agent.llm.llm_select import use_anthropic_for
    from agent.loop_drivers import _with_history_cache
    from agent.tools import registry

    history_parts = build_history_parts(
        history,
        request,
        use_anthropic=use_anthropic_for(ai),
        user_tz=None,
    )
    snapshot_context = str(snapshot.get("snapshot_context") or "")
    conversation = ([session_snapshot.reminder_message(snapshot_context)] if snapshot_context else []) + history_parts
    tools = registry.anthropic_schemas(["call_tool", "use_skill", "ask_user"])
    previous_outbound: list[dict] | None = None
    rows: list[dict[str, Any]] = []

    print(json.dumps({
        "session_id": session.id,
        "source": session.source,
        "provider": getattr(ai, "provider", "minimax"),
        "model": getattr(ai, "model", ""),
        "runs_requested": args.runs,
        "tool_schema_names": [item.get("name") for item in tools],
        "initial_history": message_shape(conversation),
        "mode": "one provider call per run; tool dispatch disabled",
    }, ensure_ascii=False), flush=True)

    for run_index in range(1, args.runs + 1):
        label, prompt = SCENARIOS[(run_index - 1) % len(SCENARIOS)]
        current_user = {"role": "user", "content": prompt}
        request_messages = assembly.PromptMessages(
            conversation,
            fixed_prefix_size=1 if snapshot_context else 0,
        )
        turn_batch, _ = assembly.assemble_turn(
            stance=f"诊断 run {run_index} 的姿态",
            current_user=current_user,
        )
        request_messages.append_batch(turn_batch)
        outbound = _with_history_cache(request_messages)
        started = time.perf_counter()
        try:
            response = await call_minimax(ai, str(snapshot["system_prompt"]), outbound, tools)
            calls, blocks = extract_tool_calls(response)
            usage = usage_values(response.usage)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            row = {
                "run": run_index,
                "scenario": label,
                "ok": True,
                "elapsed_ms": elapsed_ms,
                "request": message_shape(outbound),
                "first_diff_from_previous_run": first_diff(previous_outbound, outbound),
                "tool_calls": [call["name"] for call in calls],
                "tool_call_count": len(calls),
                "usage": usage,
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            previous_outbound = outbound
            # 只把 provider 返回的结构化 assistant/tool history 带到下一 run。
            conversation.extend([current_user])
            append_response_history(conversation, response, calls, blocks)
        except Exception as exc:
            row = {
                "run": run_index,
                "scenario": label,
                "ok": False,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "request": message_shape(outbound),
                "first_diff_from_previous_run": first_diff(previous_outbound, outbound),
                "error_type": type(exc).__name__,
                "error": str(exc)[:240],
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            break
        if args.pause:
            await asyncio.sleep(args.pause)

    successful = [row for row in rows if row.get("ok")]
    ratios = [float(row["usage"]["cache_ratio"]) for row in successful]
    summary = {
        "runs_completed": len(successful),
        "runs_requested": args.runs,
        "complete": len(successful) == args.runs,
        "cache_ratio_avg": round(sum(ratios) / len(ratios), 2) if ratios else 0,
        "cache_ratio_min": min(ratios) if ratios else 0,
        "cache_ratio_max": max(ratios) if ratios else 0,
        "tool_call_runs": sum(1 for row in successful if row.get("tool_call_count")),
        "observed_tools": sorted({name for row in successful for name in row.get("tool_calls", [])}),
    }
    print(json.dumps({"summary": summary}, ensure_ascii=False), flush=True)
    if args.output:
        Path(args.output).write_text(json.dumps({"summary": summary, "runs": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if summary["complete"] else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="真实 session 的 Minimax M3 连续 20-run cache 诊断")
    parser.add_argument("--session-id", type=int, help="固定 session；默认选最近有 snapshot 的 session")
    parser.add_argument("--model", help="按模型名进一步筛选 Minimax M3 预设")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--max-messages", type=int, default=200)
    parser.add_argument("--pause", type=float, default=1.0, help="run 间暂停秒数，默认 1 秒")
    parser.add_argument("--output", help="写入脱敏 JSON 报告的路径")
    args = parser.parse_args()
    if args.runs != 20:
        parser.error("本诊断固定要求 20 个 run；如需其他数量请另建测试脚本")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
