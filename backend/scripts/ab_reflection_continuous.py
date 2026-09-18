"""PRD-LLM-27 连续对话缓存 A/B：主对话与反思交替进行，双向记录缓存率。

与旧 ab_reflection_cache.py（单触发点对比两模式）不同，本脚本模拟**连续对话**：
回放真实会话的交换轮，每一轮都发一次真实的主对话请求（记录主对话自身的
cache_read/fresh），每满 --reflect-every 轮插入一次 append_reuse 反思请求
（记录反思缓存率）。回答两个问题：

1. 反思请求（与主对话共享前缀）自己能命中多少缓存；
2. 夹在主对话之间的反思调用**是否影响主对话后续轮次的缓存命中**——
   对比每个反思点前后主对话轮的缓存率变化。

- 只读业务数据；不写任何业务表，不调用 Memory writer，不落反思结果。
- usage 经 usage_sink 旁路采集，主对话/反思分开记账。

用法（devserver backend 目录执行）：
    PYTHONPATH=. .venv/bin/python scripts/ab_reflection_continuous.py \
        --owner-user-id <UUID> [--session-id <int>] [--reflect-every 3] \
        [--turns 9] [--list-sessions]

输出：stdout JSON + docs/reports/OPT-Cache-Strategy-LLM27-Continuous-<时间戳>.md
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
            exchanges.append({"user": pending_user[:2000], "assistant": text[:2000]})
            pending_user = None
    return exchanges


async def list_sessions(db, user_id: UUID, min_exchanges: int) -> list[dict]:
    """列出该用户的会话与交换轮数量，供挑选素材。"""
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
    titles = {s.id: (s.title or "") for s in session_rows}
    result = []
    for session_id, messages in sorted(by_session.items()):
        result.append({
            "session_id": session_id,
            "title": titles.get(session_id, "")[:30],
            "exchanges": len(_group_exchanges(messages)),
            "enough": len(_group_exchanges(messages)) >= min_exchanges,
        })
    return sorted(result, key=lambda item: -item["exchanges"])


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


async def resolve_ai(db, user_id: UUID, settings):
    """解析用户真实模型配置（BYOK 覆盖生效），与生产主对话/反思链路同源。"""
    from agent.llm.llm_select import resolve_run_config_for_user

    run_config = await resolve_run_config_for_user(settings, db, user_id, None)
    return run_config.model


async def run_continuous(owner_user_id: UUID, session_id: int | None, *, turns: int,
                         reflect_every: int, prompt_name: str, main_max_tokens: int,
                         reflection_max_tokens: int, max_prefix_exchanges: int,
                         warmup_turns: int) -> dict:
    from agent.context import provider_runner
    from agent.context.branch import ContextBranch
    from agent.context.branch_types import BranchInput, BranchPolicy
    from agent.context.session_system import build_static_prompt
    from agent.llm import modelctx
    from agent.memory import reflection

    settings = get_settings()
    async with _db_session_factory() as db:
        user = await db.get(User, owner_user_id)
        if user is None:
            raise SystemExit(f"用户不存在: {owner_user_id}")
        user_name = user.display_name or user.username
        if session_id is None:
            sessions = await list_sessions(db, owner_user_id, warmup_turns + turns)
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
    needed = warmup_turns + turns
    if len(exchanges) < needed:
        raise SystemExit(f"该会话只有 {len(exchanges)} 轮交换，需要 ≥{needed}")
    # 取会话尾段做连续对话窗口；前缀最多回看 max_prefix_exchanges 轮（控成本），
    # 窗口起点之前的历史作为「已发生的长会话」并入前缀——贴近生产：反思发生在
    # 长会话深处。
    window_start = max(0, len(exchanges) - needed)
    prefix_head_start = max(0, window_start - max_prefix_exchanges)

    modelctx.mark_user_scope()
    modelctx.set_model_cfg(ai)
    modelctx.set_usage_context(str(owner_user_id), session_id, scenario="reflection")

    system_prompt = build_static_prompt(prompt_name, user_name)
    branch = ContextBranch()
    timeline: list[dict] = []

    def _prefix_exchanges(upto_index: int) -> list[dict]:
        """渲染到第 upto_index 轮（含）为止的完整前缀历史（canonical 形态）。"""
        history = []
        for exchange in exchanges[prefix_head_start:upto_index + 1]:
            history.append({"role": "user", "content": exchange["user"]})
            history.append({"role": "assistant", "content": exchange["assistant"]})
        return history

    for offset in range(turns):
        turn_index = window_start + offset
        exchange = exchanges[turn_index]
        turn_no = offset + 1

        # ① 主对话轮（生产中即聊天本身）：完整前缀 + 本轮 user 消息。
        # 尾部追加固定 system-reminder 模拟 dynamic tail 的位置（内容恒定，
        # 隔离「反思是否断缓存」这个变量——真实时间每轮必变属另一已知因素）。
        main_history = _prefix_exchanges(turn_index - 1)
        from agent.context.prefix_history import render_branch_prefix

        main_wire = render_branch_prefix(
            main_history + [{"role": "user", "content": exchange["user"]}], ai)
        main_sink: list = []
        await provider_runner.complete_messages(
            system_prompt, main_wire,
            "【system-reminder】内部提醒占位，正文恒定用于缓存对照（不属于对话内容）",
            settings, max_tokens=main_max_tokens, usage_sink=main_sink)
        main_usage = _usage_summary(main_sink[-1] if main_sink else None)
        timeline.append({"turn": turn_no, "kind": "main",
                         "prefix_exchanges": turn_index - prefix_head_start,
                         "usage": main_usage})

        # ② 每满 reflect_every 轮插入一次 append_reuse 反思（走生产 ContextBranch）。
        if turn_no % reflect_every == 0:
            prev = exchanges[turn_index - 1] if turn_index > prefix_head_start else None
            prev_turn = {"u": prev["user"][:200], "a": prev["assistant"][:300]} if prev else None
            append_delta = (
                "【内部记忆反思任务——本消息不属于对话内容，请勿回应】\n"
                f"{reflection._load_sys()}\n\n"
                + reflection._reflection_context_block("（暂无）", "（暂无）", "（暂无）", prev_turn)
                + "【待反思回合（只从这些回合提取；上面的会话历史仅用于理解指代，不要为历史内容新建记忆）】\n"
                + f"【回合 1】\n用户({user_name})：{exchange['user']}\n咕咕：{exchange['assistant']}\n\n"
                + reflection._TASK_REQUIREMENTS
            )
            reflect_wire = render_branch_prefix(_prefix_exchanges(turn_index), ai)
            reflect_result = await branch.run(
                BranchInput(
                    stable_system=system_prompt,
                    delta=append_delta,
                    scope="owner",
                    session_id=session_id,
                    run_id=f"ab-cont-{int(time.time())}",
                    history_messages=tuple(reflect_wire),
                    branch_mode="append_reuse",
                ),
                BranchPolicy(name="reflection", output_mode="json",
                             max_tokens=reflection_max_tokens, max_retries=0,
                             thinking="disabled"),
                settings,
            )
            timeline.append({"turn": turn_no, "kind": "reflection",
                             "prefix_exchanges": turn_index - prefix_head_start + 1,
                             "ok": reflect_result.ok,
                             "usage": _usage_summary(reflect_result.provider_usage)})

    # 汇总：主对话整体 + 每个反思点前后的主对话缓存率（回答「反思是否影响主对话」）。
    main_items = [item for item in timeline if item["kind"] == "main"]
    reflect_items = [item for item in timeline if item["kind"] == "reflection"]
    main_fresh = sum(item["usage"]["fresh_input"] for item in main_items)
    main_read = sum(item["usage"]["cache_read"] for item in main_items)
    reflect_fresh = sum(item["usage"]["fresh_input"] for item in reflect_items)
    reflect_read = sum(item["usage"]["cache_read"] for item in reflect_items)

    reflection_points = []
    for item in reflect_items:
        turn_no = item["turn"]
        before = [m["usage"]["cache_rate"] for m in main_items if m["turn"] <= turn_no][-3:]
        after = [m["usage"]["cache_rate"] for m in main_items if m["turn"] > turn_no][:3]
        reflection_points.append({
            "reflection_turn": turn_no,
            "reflection_cache_rate": item["usage"]["cache_rate"],
            "main_cache_rate_before": before,
            "main_cache_rate_after": after,
            "main_avg_before": round(sum(before) / len(before), 4) if before else None,
            "main_avg_after": round(sum(after) / len(after), 4) if after else None,
        })

    return {
        "owner": str(owner_user_id),
        "session_id": session_id,
        "provider": getattr(ai, "provider", ""),
        "model": getattr(ai, "model", ""),
        "turns": turns,
        "reflect_every": reflect_every,
        "prefix_head_exchanges": prefix_head_start,
        "timeline": timeline,
        "totals": {
            "main": {"fresh_input": main_fresh, "cache_read": main_read,
                     "cache_rate": round(main_read / (main_fresh + main_read), 4)
                     if (main_fresh + main_read) else 0.0},
            "reflection": {"fresh_input": reflect_fresh, "cache_read": reflect_read,
                           "cache_rate": round(reflect_read / (reflect_fresh + reflect_read), 4)
                           if (reflect_fresh + reflect_read) else 0.0},
        },
        "reflection_points": reflection_points,
    }


def _render_report(result: dict) -> str:
    totals = result["totals"]
    lines = [
        "# PRD-LLM-27 连续对话缓存报告（主对话 × 反思交替）",
        "",
        f"- 时间：{datetime.now().isoformat(timespec='seconds')}",
        f"- 会话：{result['session_id']}（owner {result['owner'][:8]}…）",
        f"- 模型：{result['provider']} / {result['model']}（用户真实配置，BYOK 覆盖生效）",
        f"- 轮数：{result['turns']}，每 {result['reflect_every']} 轮触发一次反思；"
        f"前缀含 {result['prefix_head_exchanges']} 轮窗口前历史",
        "",
        "## 时间线",
        "",
        "| 轮 | 类型 | fresh input | cache_read | cache_write | output | 缓存率 |",
        "|---|---|---|---|---|---|---|",
    ]
    for item in result["timeline"]:
        u = item["usage"]
        kind = "主对话" if item["kind"] == "main" else "反思"
        lines.append(
            f"| {item['turn']} | {kind} | {u['fresh_input']} | {u['cache_read']} | "
            f"{u['cache_write']} | {u['output']} | {u['cache_rate']:.1%} |")
    lines += [
        "",
        "## 汇总",
        "",
        "| 链路 | fresh input 合计 | cache_read 合计 | 缓存率 |",
        "|---|---|---|---|",
        f"| 主对话 | {totals['main']['fresh_input']} | {totals['main']['cache_read']} | "
        f"{totals['main']['cache_rate']:.1%} |",
        f"| 反思（append_reuse） | {totals['reflection']['fresh_input']} | "
        f"{totals['reflection']['cache_read']} | {totals['reflection']['cache_rate']:.1%} |",
        "",
        "## 反思点前后主对话缓存率（是否被反思打断）",
        "",
        "| 反思触发轮 | 反思缓存率 | 反思前主对话缓存率（近3轮均） | 反思后（近3轮均） |",
        "|---|---|---|---|",
    ]
    for point in result["reflection_points"]:
        fmt = lambda v: f"{v:.1%}" if v is not None else "-"
        lines.append(
            f"| {point['reflection_turn']} | {fmt(point['reflection_cache_rate'])} | "
            f"{fmt(point['main_avg_before'])} | {fmt(point['main_avg_after'])} |")
    lines += [
        "",
        "## 说明",
        "",
        "- 主对话轮尾部带恒定 system-reminder（占位 dynamic tail 位置）；内容恒定是为隔离"
        "「反思是否断主对话缓存」这一个变量。",
        "- 反思走生产 ContextBranch 真实链路（append_reuse、观测记账生效）；"
        "主对话经 complete_messages 直发。",
        "- 主对话与反思共享同一份渲染前缀（render_branch_prefix 同口径），"
        "理论上前缀命中互不干扰；本报告用数据验证。",
        f"- 报告生成脚本：`backend/scripts/ab_reflection_continuous.py`。",
    ]
    return "\n".join(lines) + "\n"


async def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-user-id", required=True)
    parser.add_argument("--session-id", type=int, default=None)
    parser.add_argument("--turns", type=int, default=9,
                        help="连续对话轮数（含反思触发轮）")
    parser.add_argument("--reflect-every", type=int, default=3,
                        help="每隔多少轮触发一次反思")
    parser.add_argument("--warmup-turns", type=int, default=3,
                        help="窗口起点之前额外要求会话已有的交换轮数（保证前缀非空）")
    parser.add_argument("--prompt-name", default="default")
    parser.add_argument("--main-max-tokens", type=int, default=256,
                        help="主对话轮的输出上限（控成本；缓存率只看输入侧）")
    parser.add_argument("--reflection-max-tokens", type=int, default=900)
    parser.add_argument("--max-prefix-exchanges", type=int, default=40,
                        help="前缀历史最多回看的交换轮数（控制成本）")
    parser.add_argument("--list-sessions", action="store_true")
    args = parser.parse_args()

    owner = UUID(args.owner_user_id)
    if args.list_sessions:
        async with _db_session_factory() as db:
            sessions = await list_sessions(db, owner, args.warmup_turns + args.turns)
            print(json.dumps(sessions, ensure_ascii=False, indent=2))
        return
    result = await run_continuous(
        owner, args.session_id, turns=args.turns, reflect_every=args.reflect_every,
        prompt_name=args.prompt_name, main_max_tokens=args.main_max_tokens,
        reflection_max_tokens=args.reflection_max_tokens,
        max_prefix_exchanges=args.max_prefix_exchanges,
        warmup_turns=args.warmup_turns)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report_path = REPORTS_DIR / f"OPT-Cache-Strategy-LLM27-Continuous-{stamp}.md"
    report_path.write_text(_render_report(result), encoding="utf-8")
    json_path = REPORTS_DIR / f"OPT-Cache-Strategy-LLM27-Continuous-{stamp}.json"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"report: {report_path}")
    print(f"json:   {json_path}")


if __name__ == "__main__":
    asyncio.run(_main())
