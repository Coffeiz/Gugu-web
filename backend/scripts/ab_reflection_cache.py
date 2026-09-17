"""PRD-LLM-27 反思缓存 A/B：同一真实会话数据上对比 standalone 与 append_reuse。

在 devserver 用真实用户配置的 LLM 跑：每个触发点先用一次「主请求模拟」调用
把会话前缀写进 provider 缓存（生产中这一步就是聊天本身，成本沉没），然后
先后执行 append_reuse（新）与 standalone（旧）两种反思请求，采集归一化
usage（fresh input / cache_read / cache_write / output）。

- 只读业务数据；除 usage 记账（scenario=reflection）外不写任何业务表，
  不调用 Memory writer、不落反思结果。
- standalone 侧用 complete_messages(history=[]) 等价模拟 _extract 的请求
  （输入 token 口径一致；structured-output 参数不影响输入缓存）。

用法（devserver backend 目录执行）：
    PYTHONPATH=. .venv/bin/python scripts/ab_reflection_cache.py \
        --owner-user-id <UUID> [--session-id <int>] [--triggers 3] \
        [--base-turns 3] [--list-sessions]

输出：stdout JSON + docs/reports/OPT-Cache-Strategy-LLM27-AB-<时间戳>.md
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from app.core.config import get_settings
from app.models import ConversationMessage, ConversationSession, User

REPORTS_DIR = Path(__file__).resolve().parents[2] / "docs" / "reports"


def _db_session_factory():
    """ensure_engine 之后再取 _SessionLocal（import 时还是 None，不能 from-import）。"""
    from app.db import session as db_session

    db_session.ensure_engine()
    return db_session._SessionLocal()


def _message_text(row: ConversationMessage) -> str:
    if row.content:
        return row.content
    parts = []
    for block in row.content_json or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "\n".join(parts)


async def _load_user(db, user_id: UUID):
    return await db.get(User, user_id)


async def list_sessions(db, user_id: UUID, min_exchanges: int) -> list[dict]:
    """列出该用户的会话与「干净文本交换轮」数量，供挑选 AB 素材。"""
    session_ids = select(ConversationSession.id).where(ConversationSession.user_id == user_id)
    rows = (await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.session_id.in_(session_ids),
               ConversationMessage.role.in_(["user", "assistant"]))
        .order_by(ConversationMessage.session_id, ConversationMessage.created_at)
    )).scalars().all()
    by_session: dict[int, list[ConversationMessage]] = {}
    for row in rows:
        by_session.setdefault(row.session_id, []).append(row)
    session_rows = (await db.execute(
        select(ConversationSession).where(ConversationSession.user_id == user_id))).scalars().all()
    titles = {session_row.id: (session_row.title or "") for session_row in session_rows}
    result = []
    for session_id, messages in sorted(by_session.items()):
        exchanges = _group_exchanges(messages)
        result.append({
            "session_id": session_id,
            "title": titles.get(session_id, "")[:30],
            "exchanges": len(exchanges),
            "enough": len(exchanges) >= min_exchanges,
        })
    return sorted(result, key=lambda item: -item["exchanges"])


def _group_exchanges(messages: list[ConversationMessage]) -> list[dict]:
    """把 user/assistant 消息配成交换轮；跳过空文本与未配对的尾部。"""
    exchanges: list[dict] = []
    pending_user: str | None = None
    for row in messages:
        text = _message_text(row).strip()
        if not text:
            continue
        if row.role == "user":
            if pending_user is not None:
                pending_user = None      # 上一条 user 没等到 assistant，丢弃
            pending_user = text
        elif row.role == "assistant" and pending_user is not None:
            exchanges.append({"user": pending_user, "assistant": text[:2000]})
            pending_user = None
    return exchanges


async def resolve_ai(db, user_id: UUID, settings):
    """解析用户真实模型配置（BYOK 覆盖生效），与生产反思链路同源。"""
    from agent.llm.llm_select import resolve_run_config_for_user

    run_config = await resolve_run_config_for_user(settings, db, user_id, None)
    return run_config.model


def _render_prefix(history_canonical: list, ai) -> list:
    from agent.context.prefix_history import render_branch_prefix

    return render_branch_prefix(history_canonical, ai)


def _usage_summary(usage: dict | None) -> dict:
    usage = usage or {}
    fresh = int(usage.get("input") or 0)
    cache_read = int(usage.get("cache_read") or 0)
    billed = fresh + cache_read
    return {
        "fresh_input": fresh,
        "cache_read": cache_read,
        "cache_write": int(usage.get("cache_write") or 0),
        "output": int(usage.get("output") or 0),
        "cache_rate": round(cache_read / billed, 4) if billed else 0.0,
    }


async def run_ab(owner_user_id: UUID, session_id: int | None, *, triggers: int,
                 base_turns: int, prompt_name: str, max_tokens: int,
                 max_prefix_exchanges: int) -> dict:
    from agent.context.branch import ContextBranch
    from agent.context.branch_types import BranchInput, BranchPolicy
    from agent.context.prefix_history import render_branch_prefix
    from agent.context import provider_runner
    from agent.context.session_system import build_static_prompt
    from agent.llm import modelctx
    from agent.memory import reflection

    settings = get_settings()
    async with _db_session_factory() as db:
        user = await _load_user(db, owner_user_id)
        if user is None:
            raise SystemExit(f"用户不存在: {owner_user_id}")
        user_name = user.display_name or user.username
        if session_id is None:
            sessions = await list_sessions(db, owner_user_id, base_turns + triggers)
            eligible = [item for item in sessions if item["enough"]]
            if not eligible:
                raise SystemExit("没有满足轮数要求的会话；先用 --list-sessions 查看")
            session_id = eligible[0]["session_id"]
        ai = await resolve_ai(db, owner_user_id, settings)
        rows = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session_id,
                   ConversationMessage.role.in_(["user", "assistant"]))
            .order_by(ConversationMessage.created_at)
        )).scalars().all()

    exchanges = _group_exchanges(rows)
    needed = base_turns + triggers
    if len(exchanges) < needed:
        raise SystemExit(f"该会话只有 {len(exchanges)} 轮交换，AB 需要 ≥{needed}（base {base_turns} + {triggers} 次触发）")
    # 触发窗口取会话尾段（最后 needed 轮）；每次触发的前缀历史 = 窗口起点之前的
    # 交换轮（最多回看 max_prefix_exchanges 轮，防超长会话成本失控）+ 窗口内已
    # 完成的轮次——贴近生产：反思发生在长会话深处，前缀是累积的会话历史。
    window_start = max(0, len(exchanges) - needed)
    prefix_head_start = max(0, window_start - max_prefix_exchanges)
    window = exchanges[window_start:]

    modelctx.mark_user_scope()
    modelctx.set_model_cfg(ai)
    modelctx.set_usage_context(str(owner_user_id), session_id, scenario="reflection")

    system_prompt = build_static_prompt(prompt_name, user_name)

    branch = ContextBranch()
    triggers_report = []
    for index in range(triggers):
        target_index = window_start + base_turns + index
        prefix_exchanges = exchanges[prefix_head_start:target_index]
        target = exchanges[target_index]
        history_canonical = []
        for exchange in prefix_exchanges:
            history_canonical.append({"role": "user", "content": exchange["user"][:2000]})
            history_canonical.append({"role": "assistant", "content": exchange["assistant"]})
        prev_turn = {"u": prefix_exchanges[-1]["user"][:200], "a": prefix_exchanges[-1]["assistant"][:300]} \
            if prefix_exchanges else None

        # ① 主请求模拟（生产中即聊天本身）：把前缀写进 provider 缓存。
        warm_history = _render_prefix(
            history_canonical + [{"role": "user", "content": target["user"]}], ai)
        warm_sink: list = []
        await provider_runner.complete_messages(
            system_prompt, warm_history,
            "【system-reminder】当前时间提醒（模拟 dynamic tail）",
            settings, max_tokens=32, usage_sink=warm_sink)
        warm_usage = _usage_summary(warm_sink[-1] if warm_sink else None)

        # ② append_reuse（新路径）：走生产 ContextBranch（branch_mode/观测/摘出全链路）。
        append_delta = (
            "【内部记忆反思任务——本消息不属于对话内容，请勿回应】\n"
            f"{reflection._load_sys()}\n\n"
            + reflection._reflection_context_block("（暂无）", "（暂无）", "（暂无）", prev_turn)
            + "【待反思回合（只从这些回合提取；上面的会话历史仅用于理解指代，不要为历史内容新建记忆）】\n"
            + f"【回合 1】\n用户({user_name})：{target['user']}\n咕咕：{target['assistant']}\n\n"
            + reflection._TASK_REQUIREMENTS
        )
        append_history = _render_prefix(
            history_canonical + [{"role": "user", "content": target["user"]},
                                 {"role": "assistant", "content": target["assistant"]}], ai)
        append_result = await branch.run(
            BranchInput(
                stable_system=system_prompt,
                delta=append_delta,
                scope="owner",
                session_id=session_id,
                run_id=f"ab-{int(time.time())}",
                history_messages=tuple(append_history),
                branch_mode="append_reuse",
            ),
            BranchPolicy(name="reflection", output_mode="json",
                         max_tokens=max_tokens, max_retries=0, thinking="disabled"),
            settings,
        )

        # ③ standalone（旧路径等价模拟）：reflection.md 为 system，无历史前缀。
        standalone_user = (
            reflection._reflection_context_block("（暂无）", "（暂无）", "（暂无）", prev_turn)
            + f"本次对话：\n用户({user_name})：{target['user']}\n咕咕：{target['assistant']}\n\n"
            + reflection._TASK_REQUIREMENTS
        )
        standalone_sink: list = []
        await provider_runner.complete_messages(
            reflection._load_sys(), [], standalone_user, settings,
            max_tokens=max_tokens, json_mode=True, usage_sink=standalone_sink)
        standalone_usage = _usage_summary(standalone_sink[-1] if standalone_sink else None)

        triggers_report.append({
            "trigger": index + 1,
            "prefix_exchanges": len(prefix_exchanges),
            "history_messages": len(append_history),
            "append": {
                "ok": append_result.ok,
                "usage": _usage_summary(append_result.provider_usage),
                "mode": append_result.metadata.get("branch_mode"),
            },
            "standalone": {"usage": standalone_usage},
            "warm_main_sim": warm_usage,
        })

    totals = {"append": {"fresh": 0, "read": 0, "out": 0},
              "standalone": {"fresh": 0, "read": 0, "out": 0}}
    for item in triggers_report:
        for mode in ("append", "standalone"):
            usage = item[mode]["usage"]
            totals[mode]["fresh"] += usage["fresh_input"]
            totals[mode]["read"] += usage["cache_read"]
            totals[mode]["out"] += usage["output"]
    for mode in ("append", "standalone"):
        billed = totals[mode]["fresh"] + totals[mode]["read"]
        totals[mode]["cache_rate"] = round(totals[mode]["read"] / billed, 4) if billed else 0.0

    return {
        "owner": str(owner_user_id),
        "session_id": session_id,
        "provider": getattr(ai, "provider", ""),
        "model": getattr(ai, "model", ""),
        "triggers": triggers,
        "base_turns": base_turns,
        "per_trigger": triggers_report,
        "totals": totals,
    }


def _render_report(result: dict) -> str:
    lines = [
        "# PRD-LLM-27 反思缓存 A/B 报告（standalone vs append_reuse）",
        "",
        f"- 时间：{datetime.now().isoformat(timespec='seconds')}",
        f"- 会话：{result['session_id']}（owner {result['owner'][:8]}…）",
        f"- 模型：{result['provider']} / {result['model']}（用户真实配置，BYOK 覆盖生效）",
        f"- 触发次数：{result['triggers']}（每次前缀递增 1 轮；主请求模拟调用单独计量，不计入两模式对比）",
        "",
        "| 触发 | 前缀轮数 | 模式 | fresh input | cache_read | cache_write | output | 缓存率 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for item in result["per_trigger"]:
        for mode, label in (("append", "append_reuse（新）"), ("standalone", "standalone（旧）")):
            u = item[mode]["usage"]
            lines.append(
                f"| {item['trigger']} | {item['prefix_exchanges']} | {label} | {u['fresh_input']} | "
                f"{u['cache_read']} | {u['cache_write']} | {u['output']} | {u['cache_rate']:.1%} |")
    totals = result["totals"]
    lines += [
        "",
        "## 汇总",
        "",
        "| 模式 | fresh input 合计 | cache_read 合计 | output 合计 | 缓存率 |",
        "|---|---|---|---|---|",
        f"| append_reuse（新） | {totals['append']['fresh']} | {totals['append']['read']} | {totals['append']['out']} | {totals['append']['cache_rate']:.1%} |",
        f"| standalone（旧） | {totals['standalone']['fresh']} | {totals['standalone']['read']} | {totals['standalone']['out']} | {totals['standalone']['cache_rate']:.1%} |",
        "",
        "## 说明",
        "",
        "- 「主请求模拟」调用的成本单独存在（生产中该请求就是聊天本身，属沉没成本），不计入两模式对比。",
        "- standalone 侧以 complete_messages(history=[]) 等价模拟 _extract 请求，输入 token 口径一致。",
        "- append 侧走生产 ContextBranch 真实链路（branch_mode=append_reuse、观测与摘出机制生效）。",
        f"- 报告生成脚本：`backend/scripts/ab_reflection_cache.py`。",
    ]
    return "\n".join(lines) + "\n"


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-user-id", required=True)
    parser.add_argument("--session-id", type=int, default=None)
    parser.add_argument("--triggers", type=int, default=3)
    parser.add_argument("--base-turns", type=int, default=3)
    parser.add_argument("--prompt-name", default="default")
    parser.add_argument("--max-tokens", type=int, default=900)
    parser.add_argument("--max-prefix-exchanges", type=int, default=40,
                        help="前缀历史最多回看的交换轮数（控制成本）")
    parser.add_argument("--list-sessions", action="store_true")
    args = parser.parse_args()

    owner = UUID(args.owner_user_id)
    async with _db_session_factory() as db:
        if args.list_sessions:
            sessions = await list_sessions(db, owner, args.base_turns + args.triggers)
            print(json.dumps(sessions, ensure_ascii=False, indent=2))
            return
    result = await run_ab(owner, args.session_id, triggers=args.triggers,
                          base_turns=args.base_turns, prompt_name=args.prompt_name,
                          max_tokens=args.max_tokens,
                          max_prefix_exchanges=args.max_prefix_exchanges)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = REPORTS_DIR / f"OPT-Cache-Strategy-LLM27-AB-{stamp}.md"
    report_path.write_text(_render_report(result), encoding="utf-8")
    json_path = REPORTS_DIR / f"OPT-Cache-Strategy-LLM27-AB-{stamp}.json"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report: {report_path}")
    print(f"json:   {json_path}")


if __name__ == "__main__":
    asyncio.run(_main())
