"""批量回顾性刷新 .agent 记忆文件——记忆算法/规则改了之后，手动跑一次让存量数据补齐。

不是"全部重新生成"，是按操作名分别刷新，只跑你指定的那几项。以后哪次改了 reflection.md /
compress.py 之类的算法，照着 OPS 里的样子加一个新函数、注册进去就行，不用动其它已有的操作。

现有操作：
- facts：拿现有 pattern.json（行为/决策模式，2026-07-08 从 facts.json 更名，见
  docs/agent/11-记忆系统.md §3）整份，对照 reflection.md 现行「抽象测试」标准复核，删掉不该在
  这的（常见于旧版 facts.md/facts.json 迁移批次——那批没经过现在这套更细的筛选标准，见 devlog）。
  ⚠️ 同一份输入模型判断可能不稳定（同一 prompt 两次调用删除比例差过一倍，包括该保护的条目
  被误删），所以对每个用户跑 --trials 次独立判断、只删多数次都判定该删的条目，不信单次结果。
- cleanup-legacy：pattern.json 已存在（说明该用户已经迁移过）时，删掉不再被读写的旧
  facts.json / facts.md，纯粹清死重量，不影响任何记忆内容

跑法：
    cd backend && .venv/bin/python scripts/refresh_memory.py --facts            # 真的写（默认 3 次投票）
    cd backend && .venv/bin/python scripts/refresh_memory.py --facts --dry-run  # 只看会删什么，不写
    cd backend && .venv/bin/python scripts/refresh_memory.py --facts --user <uuid> --trials 5  # 调试/调参
    cd backend && .venv/bin/python scripts/refresh_memory.py --cleanup-legacy --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path


_REVIEW_SYS_PROMPT = (
    "你在复核一个 AI 助理已经记住的、关于某用户的「行为/决策模式」列表(pattern)，挑出不该留在这里的条目。\n"
    "这份列表只回答「这个人做事/做决定的可复用习惯是什么」，跟具体项目、具体时间点都无关——"
    "项目/事件的具体来龙去脉另有 memory.md 的叙事记录着，不用这里重复存；具体项目/日程条目"
    "本来就在数据库里，查得到就不用记。\n"
    "判据是「抽象测试」：**去掉具体项目名/具体数字/具体日期后，这句话还剩不剩一个能套到其他"
    "情境的通用行为模式？** 剩就该留（\"对方案持审慎态度，要求核实事实\"、\"某个长期存在的定时"
    "任务该在什么时间触发/汇报时该注意什么\"这类复用规则，即使内容看着像某次具体经历，也要留）；"
    "不剩就不该留（某次具体决定的内容、某个项目的执行细节/任务勾选状态，这些属于当下进展，不是"
    "可复用的模式）。\n"
    "- 也不留：一次性的日程/事务提醒(\"某服务到期了、明天要续费\")、推测性且已经过时/被现实"
    "推翻的信息、活动本身的信息（不是关于用户的）\n"
    "- 拿不准就留着，宁可漏删也别误删\n"
    "只输出 JSON：{\"remove\": [编号, ...]}（不该留的条目编号数组，没有就给空数组）"
)


async def _review_once(facts: list[dict], settings, temperature: float) -> set[int] | None:
    """单次调用，返回本次判定要删的下标集合；解析失败返回 None（不计入投票）。"""
    from agent.memory._llm import complete_json

    lines = "\n".join(f"[{i}] ({f.get('kind')}) {f.get('text', '')}" for i, f in enumerate(facts))
    result = await complete_json(_REVIEW_SYS_PROMPT, lines, settings, max_tokens=800, temperature=temperature)
    idxs = result.get("remove")
    if not isinstance(idxs, list):
        return None
    return {i for i in idxs if isinstance(i, int) and 0 <= i < len(facts)}


async def _review_facts(user_id: str, settings, dry_run: bool,
                         trials: int = 3, temperature: float = 0.1) -> dict:
    """复核一个用户的 facts.json，挑出不符合现行「只记什么」标准的条目并删除。

    同一份输入、同一份 prompt，模型两次调用的判断可能差很多（踩过：87%→94% 的删除比例大幅波动，
    包括本该保护的条目被反复误删）——不能信单次调用的结果。这里对同一批 facts 跑 `trials` 次
    独立判断，只删「多数次都判定该删」的条目（过半才算数），单次的分歧判断视为不确定、保留。
    """
    from agent.memory import store

    facts = await store.read_facts_list(user_id)
    if not facts:
        return {"total": 0, "removed": 0}

    votes: dict[int, int] = {}
    ok_trials = 0
    for _ in range(trials):
        r = await _review_once(facts, settings, temperature)
        if r is None:
            continue
        ok_trials += 1
        for i in r:
            votes[i] = votes.get(i, 0) + 1
    if ok_trials == 0:
        return {"total": len(facts), "removed": 0, "error": "所有轮次模型输出都解析失败，本用户跳过"}

    majority = ok_trials / 2
    valid = sorted(i for i, v in votes.items() if v > majority)
    if not valid:
        return {"total": len(facts), "removed": 0, "trials_ok": ok_trials,
                "unstable": {i: v for i, v in votes.items() if v <= majority}}

    removed_texts = [facts[i]["text"] for i in valid]
    removed_ids = [facts[i]["id"] for i in valid]
    if not dry_run:
        remove_set = set(removed_ids)
        new_facts = [f for f in facts if f["id"] not in remove_set]
        await store.write_facts_list(user_id, new_facts)
        await store.sync_fact_vecs(user_id, new_facts)
    return {
        "total": len(facts), "removed": len(valid),
        "removed_texts": removed_texts, "removed_ids": removed_ids,
        "trials_ok": ok_trials,
        "unstable": {i: v for i, v in votes.items() if v <= majority and v > 0},
    }


async def _cleanup_legacy(user_id: str, settings, dry_run: bool, **_ignored) -> dict:
    """pattern.json 已存在（该用户已迁移过）时，删掉不再被读写的旧 facts.json / facts.md。"""
    from agent.memory import store
    from agent.memory.store import _key
    from app.services.storage import get_storage

    storage = get_storage()
    pattern_key = _key(user_id, store.FACTS_FILE)   # 现在的真实文件名，如 "pattern.json"
    if not await storage.exists(pattern_key):
        return {"removed": 0}
    removed = []
    for legacy_name in ("facts.json", "facts.md"):
        legacy_key = _key(user_id, legacy_name)
        if await storage.exists(legacy_key):
            if not dry_run:
                await storage.delete(legacy_key)
            removed.append(legacy_key)
    return {"removed": len(removed), "removed_texts": removed}


OPS = {
    "facts": _review_facts,
    "cleanup-legacy": _cleanup_legacy,
}


async def _all_user_ids() -> list[str]:
    from app.db.session import get_db
    from app.models import User
    from sqlalchemy import select

    async for db in get_db():
        rows = (await db.execute(select(User.id))).scalars().all()
        return [str(u) for u in rows]
    return []


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    for name in OPS:
        ap.add_argument(f"--{name}", action="store_true", help=f"跑「{name}」刷新操作")
    ap.add_argument("--dry-run", action="store_true", help="只打印会改什么，不实际写")
    ap.add_argument("--user", help="只跑这一个 user_id（调试用），不给则跑全部用户")
    ap.add_argument("--trials", type=int, default=3, help="facts 复核每个用户独立调用几次、多数票才删（默认 3）")
    ap.add_argument("--temperature", type=float, default=0.1, help="facts 复核调用的 temperature（默认 0.1，越低越稳定）")
    args = ap.parse_args()

    ops = [name for name in OPS if getattr(args, name.replace("-", "_"))]
    if not ops:
        ap.print_help()
        return

    from app.core.config import get_settings
    settings = get_settings()
    user_ids = [args.user] if args.user else await _all_user_ids()
    print(f"共 {len(user_ids)} 个用户，操作：{ops}{'（dry-run，不会真的写）' if args.dry_run else ''}")

    for op_name in ops:
        op = OPS[op_name]
        touched = 0
        for uid in user_ids:
            res = await op(uid, settings, args.dry_run, trials=args.trials, temperature=args.temperature)
            if res.get("removed") or res.get("error") or res.get("unstable"):
                touched += 1
                print(f"[{op_name}] {uid}: {res}")
        print(f"[{op_name}] 完成，{len(user_ids)} 个用户里 {touched} 个有改动/有分歧")

    print("done")


if __name__ == "__main__":
    asyncio.run(main())
