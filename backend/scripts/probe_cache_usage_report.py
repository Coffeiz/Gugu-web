"""探针：连续请求观测 provider 的 usage/cache 上报口径（PRD-LLM-27 后续排查）。

用合成的定长对话连续打 N 次真实请求：第 k 次请求 = 前 k-1 轮的完整历史 +
本轮 user 消息。结构上前缀只增不减，理论上 cache_read 应单调递增且
≤ 上一次请求的总输入。打印每次的原始 usage 与 sanity 检查，直接暴露：

- cache_read 是否超过历史总输入（多锚点重复累计的口径问题）；
- 前缀是否真的命中（read 占上次总输入的比例）；
- fresh 是否等于本轮新增。

运行会发送真实模型请求；provider 仍可能计费。请求只在明确传入
--allow-real-llm 后执行。默认不落 agent_usage（不设 usage context，
record_current_usage 静默跳过），不污染 Gugu 的用量统计。

用法（devserver backend 目录执行）：
    PYTHONPATH=. .venv/bin/python scripts/probe_cache_usage_report.py \
        --allow-real-llm [--owner-user-id <UUID>] [--turns 5] \
        [--filler-chars 4000]

不传 --owner-user-id 时用平台配置模型（admin 配置的非 BYOK 模型）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
from uuid import UUID

_FILLER = (
    "这是一段用于撑起上下文体积的填充文本，内容本身没有信息量，但每次请求都逐字节相同，"
    "用于让 provider 的前缀缓存可以稳定命中。乘以 N 份拼接出目标体积。"
)


def _db_session_factory():
    from app.db import session as db_session

    db_session.ensure_engine()
    return db_session._SessionLocal()


def _filler_text(chars: int) -> str:
    reps = max(1, chars // len(_FILLER))
    return (_FILLER * reps)[:chars]


def _summarize(idx: int, user_len: int, history_msgs: int, usage: dict | None,
               prev_total_input: int | None) -> dict:
    usage = usage or {}
    fresh = int(usage.get("input") or 0)
    read = int(usage.get("cache_read") or 0)
    write = int(usage.get("cache_write") or 0)
    out = int(usage.get("output") or 0)
    total_input = fresh + read
    checks = {
        "read_le_prev_total": (read <= prev_total_input) if prev_total_input else None,
        "read_le_total_input": read <= total_input,
        "read_over_prev_by": (read - prev_total_input) if prev_total_input and read > prev_total_input else 0,
    }
    return {
        "call": idx,
        "history_msgs": history_msgs,
        "user_chars": user_len,
        "usage": {"input": fresh, "cache_read": read, "cache_write": write, "output": out},
        "total_input": total_input,
        "read_vs_prev_total": (f"{read}/{prev_total_input}" if prev_total_input else "cold"),
        "_checks": checks,
        "_raw_keys": sorted(usage.keys()),
    }


async def run_probe(owner_user_id: UUID | None, *, turns: int, filler_chars: int,
                    max_tokens: int) -> dict:
    from app.core.config import get_settings
    from agent.context import provider_runner
    from agent.llm import modelctx

    settings = get_settings()
    if owner_user_id is not None:
        from agent.llm.llm_select import resolve_run_config_for_user

        async with _db_session_factory() as db:
            run_config = await resolve_run_config_for_user(settings, db, owner_user_id, None)
        ai = run_config.model
    else:
        from agent.llm.llm_select import resolve_run_config

        ai = resolve_run_config(settings, None).model

    # 关键：不 set_usage_context → record_current_usage 静默跳过，不落 agent_usage。
    modelctx.mark_user_scope()
    modelctx.set_model_cfg(ai)

    filler = _filler_text(filler_chars)
    system = "你是缓存观测探针。无论用户说什么，都只回复「ok」。"
    history: list = []      # wire 形态，逐步追加
    timeline = []
    prev_total_input: int | None = None

    for idx in range(1, turns + 1):
        user_msg = f"【第 {idx} 轮】{filler}"
        sink: list = []
        await provider_runner.complete_messages(
            system, list(history), user_msg, settings,
            max_tokens=max_tokens, usage_sink=sink)
        usage = sink[-1] if sink else None
        report = _summarize(idx, len(user_msg), len(history), usage, prev_total_input)
        timeline.append(report)
        prev_total_input = report["total_input"]
        # 追加本轮：user + assistant（assistant 回复固定短句，模拟下一轮前缀增长）
        history.append({"role": "user", "content": user_msg})
        history.append({"role": "assistant", "content": "ok"})

    return {
        "provider": getattr(ai, "provider", ""),
        "model": getattr(ai, "model", ""),
        "api_format": getattr(ai, "api_format", ""),
        "turns": turns,
        "filler_chars": filler_chars,
        "recorded": False,
        "timeline": timeline,
    }


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-real-llm", action="store_true",
                        help="明确允许发送真实模型请求，provider 可能计费")
    parser.add_argument("--owner-user-id", default=None)
    parser.add_argument("--turns", type=int, default=5,
                        help="请求轮数，限制为 1–20 次")
    parser.add_argument("--filler-chars", type=int, default=4000,
                        help="每轮填充文本的字符数（约几百 token，控制每轮增量）")
    parser.add_argument("--max-tokens", type=int, default=16)
    args = parser.parse_args()

    if not args.allow_real_llm:
        parser.error("默认不发送真实请求；确认可能产生 provider 费用后再加 --allow-real-llm")
    if not 1 <= args.turns <= 20:
        parser.error("--turns 必须在 1 到 20 之间")

    owner = UUID(args.owner_user_id) if args.owner_user_id else None
    result = await run_probe(owner, turns=args.turns,
                             filler_chars=args.filler_chars, max_tokens=args.max_tokens)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
