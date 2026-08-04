"""批量回顾性刷新 .agent 记忆文件——记忆算法/规则改了之后，手动跑一次让存量数据补齐。

不是"全部重新生成"，是按操作名分别刷新，只跑你指定的那几项。以后哪次改了 reflection.md /
compress.py 之类的算法，照着 OPS 里的样子加一个新函数、注册进去就行，不用动其它已有的操作。

现有操作：
- patterns：拿现有 pattern.json（行为/决策模式，2026-07-08 从 facts.json 更名，见
  docs/agent/11-记忆系统.md §3）整份，对照 reflection.md 现行「抽象测试」标准维护：优先合并
  重复/近义条目，只删除明确不该在这里的内容（常见于旧版 facts.md/facts.json 迁移批次——那批
  没经过现在这套更细的筛选标准，见 devlog）。
  ⚠️ 同一份输入模型判断可能不稳定（同一 prompt 两次调用删除比例差过一倍，包括该保护的条目
  被误删），所以对每个用户跑 --trials 次独立判断，合并和删除都只采纳多数票，不信单次结果。
- cleanup-legacy：pattern.json 已存在（说明该用户已经迁移过）时，删掉不再被读写的旧
  facts.json / facts.md / facts_vec.json（向量缓存改名前的旧文件），纯粹清死重量，
  不影响任何记忆内容（向量缓存本身可重建）
- split-profile：profile.json 是全新概念，没有旧数据自动迁移过去——用户 2026-07-08 前记的
  "住哪/是干嘛的"这类身份信息，都跟着旧 facts.json 整份进了 pattern.json，没有被区分出来。
  这个操作把 pattern.json 里其实该算「画像」的条目挑出来搬进 profile.json（一次性迁移债）。
- migrate-daily：旧版 daily.md 用的是每行 `- YYYY-MM-DD 内容`；现在改成 `## 日期` 下挂多条
  bullet。运行时不再兼容旧格式，这个操作负责一次性改写存量 daily.md。
- migrate-profile-events：早期 profile 里混进过「最近/刚/这阵子」这类阶段性事件。它们不该留在
  画像层，而应迁去 memory.md；这个操作负责一次性把这批条目从 profile 挪到长期叙事层。

跑法：
    cd backend && .venv/bin/python scripts/refresh_memory.py --patterns            # 真的写（默认 3 次投票）
    cd backend && .venv/bin/python scripts/refresh_memory.py --patterns --dry-run  # 只看会删什么，不写
    cd backend && .venv/bin/python scripts/refresh_memory.py --patterns --user <uuid> --trials 5  # 调试/调参
    兼容性：`--facts` 是旧命令别名，仍可用，但新脚本请使用 `--patterns`。
    cd backend && .venv/bin/python scripts/refresh_memory.py --cleanup-legacy --dry-run
    cd backend && .venv/bin/python scripts/refresh_memory.py --split-profile --dry-run
    cd backend && .venv/bin/python scripts/refresh_memory.py --migrate-daily --dry-run
    cd backend && .venv/bin/python scripts/refresh_memory.py --migrate-profile-events --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path


_PROFILE_TEMPORAL_RE = re.compile(r"(最近|刚|刚刚|这阵子|这几天|这周|本周|目前|现在|近期)")


_REVIEW_SYS_PROMPT = (
    "你在维护一个 AI 助理已经记住的、关于某用户的「行为/决策模式」列表(pattern)。维护目标是"
    "让列表更精炼，但优先合并重复/近义条目，尽量保留高置信度内容，不要轻易删除。\n"
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
    "- 重复/近义条目不要删除，放进 merge；高置信度（尤其 observed）条目只能作为合并保留项，"
    "除非明确已经被事实推翻\n"
    "- 拿不准就原样保留，宁可漏合并/漏删也别误删\n"
    "只输出 JSON：{\"merge\":[{\"keep\":主条目编号,\"merge\":[需合并的其它编号],"
    "\"text\":\"合并后的通用表述\"}],\"remove\":[明确不该保留的编号]}。"
    "没有合并或删除时使用空数组。merge 中的 keep 不要重复出现在 remove。"
)


async def _review_once(patterns: list[dict], settings, temperature: float) -> dict | None:
    """单次调用，返回合并/删除建议；解析失败返回 None（不计入投票）。"""
    from agent.memory._llm import complete_json

    lines = "\n".join(f"[{i}] ({f.get('kind')}) {f.get('text', '')}" for i, f in enumerate(patterns))
    # merge 需要返回合并后的表述；老用户 pattern 可能有上百条，800 token 容易在 JSON 收尾前被截断。
    result = await complete_json(_REVIEW_SYS_PROMPT, lines, settings, max_tokens=2000, temperature=temperature)
    if "remove" not in result and "merge" not in result:
        return None
    remove = result.get("remove", [])
    merge = result.get("merge", [])
    if not isinstance(remove, list) or not isinstance(merge, list):
        return None
    valid_remove = {i for i in remove if isinstance(i, int) and 0 <= i < len(patterns)}
    valid_merge = []
    for group in merge:
        if not isinstance(group, dict) or not isinstance(group.get("keep"), int):
            continue
        keep = group["keep"]
        members = group.get("merge", [])
        if not (0 <= keep < len(patterns)) or not isinstance(members, list):
            continue
        members = sorted({i for i in members if isinstance(i, int) and 0 <= i < len(patterns) and i != keep})
        if members:
            valid_merge.append({"keep": keep, "merge": members, "text": str(group.get("text") or "").strip()})
    return {"remove": valid_remove, "merge": valid_merge}


def _pattern_strength(pattern: dict) -> tuple[int, float, int, float]:
    """合并时优先保留 observed、高置信度、高重要度、较新的条目。"""
    return (
        1 if pattern.get("kind") == "observed" else 0,
        float(pattern.get("conf", 0.0) or 0.0),
        int(pattern.get("imp", 0) or 0),
        float(pattern.get("ts", 0.0) or 0.0),
    )


def _protected_pattern(pattern: dict) -> bool:
    """高置信模式默认只允许被合并，不允许被维护投票单独删除。"""
    conf = float(pattern.get("conf", 0.0) or 0.0)
    return conf >= 0.85 or (pattern.get("kind") == "observed" and conf >= 0.8)


async def _review_patterns(user_id: str, settings, dry_run: bool,
                         trials: int = 3, temperature: float = 0.1) -> dict:
    """复核一个用户的 pattern.json，挑出不符合现行「只记什么」标准的条目并删除。

    同一份输入、同一份 prompt，模型两次调用的判断可能差很多——不能信单次调用的结果。
    这里对同一批 pattern 跑 `trials` 次独立判断，合并组和删除项都只采纳多数票；高置信条目
    由代码额外保护，避免模型把高价值内容误删。
    """
    from agent.memory import store

    patterns = await store.read_pattern_list(user_id)
    if not patterns:
        return {"total": 0, "removed": 0}

    remove_votes: dict[int, int] = {}
    merge_votes: dict[tuple[int, ...], dict] = {}
    ok_trials = 0
    for _ in range(trials):
        r = await _review_once(patterns, settings, temperature)
        if r is None:
            continue
        ok_trials += 1
        for i in r["remove"]:
            remove_votes[i] = remove_votes.get(i, 0) + 1
        for group in r["merge"]:
            key = tuple(sorted({group["keep"], *group["merge"]}))
            entry = merge_votes.setdefault(key, {"votes": 0, "texts": []})
            entry["votes"] += 1
            if group["text"]:
                entry["texts"].append(group["text"])
    if ok_trials == 0:
        return {"total": len(patterns), "removed": 0, "error": "所有轮次模型输出都解析失败，本用户跳过"}

    majority = ok_trials / 2
    valid_remove = sorted(
        i for i, v in remove_votes.items()
        if v > majority and not _protected_pattern(patterns[i])
    )
    valid_merges = {
        key: value for key, value in merge_votes.items() if value["votes"] > majority
    }
    if not valid_remove and not valid_merges:
        return {"total": len(patterns), "removed": 0, "trials_ok": ok_trials,
                "merged": 0,
                "unstable": {i: v for i, v in remove_votes.items() if v <= majority}}

    remove_set = {patterns[i]["id"] for i in valid_remove}
    merged_ids: set[str] = set()
    merged_records: list[dict] = []
    for key, value in valid_merges.items():
        members = [patterns[i] for i in key]
        canonical = max(members, key=_pattern_strength)
        merged = dict(canonical)
        merged["kind"] = "observed" if any(item.get("kind") == "observed" for item in members) else canonical.get("kind", "inferred")
        merged["conf"] = min(0.97, max(float(item.get("conf", 0.6) or 0.6) for item in members))
        merged["imp"] = max(int(item.get("imp", 0) or 0) for item in members)
        merged["ts"] = max(float(item.get("ts", 0.0) or 0.0) for item in members)
        if value["texts"]:
            merged["text"] = max(value["texts"], key=len)
        merged_records.append(merged)
        merged_ids.update(item["id"] for item in members if item["id"] != canonical["id"])
    remove_set.update(merged_ids)
    if not dry_run:
        replacement = {item["id"]: item for item in merged_records}
        new_patterns = []
        for pattern in patterns:
            if pattern["id"] in replacement:
                new_patterns.append(replacement[pattern["id"]])
            elif pattern["id"] not in remove_set:
                new_patterns.append(pattern)
        await store.write_pattern_list(user_id, new_patterns)
        await store.sync_pattern_vecs(user_id, new_patterns)
    return {
        "total": len(patterns), "removed": len(valid_remove), "merged": len(valid_merges),
        "removed_texts": [patterns[i]["text"] for i in valid_remove],
        "removed_ids": [patterns[i]["id"] for i in valid_remove],
        "merged_ids": sorted(merged_ids),
        "trials_ok": ok_trials,
        "unstable": {i: v for i, v in remove_votes.items() if v <= majority and v > 0},
    }


async def _cleanup_legacy(user_id: str, settings, dry_run: bool, **_ignored) -> dict:
    """pattern.json 已存在（该用户已迁移过）时，删掉不再被读写的旧 facts.json / facts.md /
    facts_vec.json（向量缓存改名前的旧文件，自身可重建，删了没损失，next sync_pattern_vecs 会
    在 pattern_vec.json 下自动重嵌）。"""
    from agent.memory import store
    from agent.memory.store import _key
    from app.services.storage import get_storage

    storage = get_storage()
    pattern_key = _key(user_id, store.PATTERN_FILE)   # 现在的真实文件名，如 "pattern.json"
    if not await storage.exists(pattern_key):
        return {"removed": 0}
    removed = []
    for legacy_name in ("facts.json", "facts.md", "facts_vec.json"):
        legacy_key = _key(user_id, legacy_name)
        if await storage.exists(legacy_key):
            if not dry_run:
                await storage.delete(legacy_key)
            removed.append(legacy_key)
    return {"removed": len(removed), "removed_texts": removed}


_SPLIT_SYS_PROMPT = (
    "你在复核一份「行为/决策模式」列表(pattern)，挑出其中其实该属于「用户画像」(profile)的条目——\n"
    "这些条目该搬到画像文件里，不该继续留在这份行为模式列表里。\n"
    "判据：这条是不是「这个人是谁」的稳定属性——身份/职业/所在地/稳定喜好，跟"
    "「这个人做事/做决定的习惯」（行为模式，该留在原地）是两回事。\n"
    "例：\"用户住南京\"\"用户是自由创作者\"该搬去画像；"
    "\"对方案持审慎态度，要求核实事实\"是行为模式，不搬。\n"
    "- 拿不准就留在原地不搬（宁可漏搬也别误搬）\n"
    "只输出 JSON：{\"move\": [编号, ...]}（该搬去 profile 的条目编号数组，没有就给空数组）"
)


async def _split_once(patterns: list[dict], settings, temperature: float) -> set[int] | None:
    from agent.memory._llm import complete_json

    lines = "\n".join(f"[{i}] ({f.get('kind')}) {f.get('text', '')}" for i, f in enumerate(patterns))
    result = await complete_json(_SPLIT_SYS_PROMPT, lines, settings, max_tokens=800, temperature=temperature)
    idxs = result.get("move")
    if not isinstance(idxs, list):
        return None
    return {i for i in idxs if isinstance(i, int) and 0 <= i < len(patterns)}


async def _split_profile(user_id: str, settings, dry_run: bool,
                          trials: int = 3, temperature: float = 0.1, **_ignored) -> dict:
    """把 pattern.json 里其实该属于 profile 的条目搬过去——2026-07-08 拆分时 profile.json
    是全新文件，没有旧数据可迁移，这批「身份类」内容当时跟着整份 facts.json 进了 pattern.json，
    一直没被区分出来。同样用多数票机制（理由跟 _review_patterns 一样：单次调用不可信）。"""
    from agent.memory import store

    patterns = await store.read_pattern_list(user_id)
    if not patterns:
        return {"total": 0, "moved": 0}

    votes: dict[int, int] = {}
    ok_trials = 0
    for _ in range(trials):
        r = await _split_once(patterns, settings, temperature)
        if r is None:
            continue
        ok_trials += 1
        for i in r:
            votes[i] = votes.get(i, 0) + 1
    if ok_trials == 0:
        return {"total": len(patterns), "moved": 0, "error": "所有轮次模型输出都解析失败，本用户跳过"}

    majority = ok_trials / 2
    valid = sorted(i for i, v in votes.items() if v > majority)
    if not valid:
        return {"total": len(patterns), "moved": 0, "trials_ok": ok_trials,
                "unstable": {i: v for i, v in votes.items() if v <= majority}}

    moved_texts = [patterns[i]["text"] for i in valid]
    moved_ids = {patterns[i]["id"] for i in valid}
    if not dry_run:
        profile = await store.read_profile_list(user_id)
        profile = store.apply_profile_ops(profile, moved_texts, [])
        await store.write_profile_list(user_id, profile)
        new_patterns = [pattern for pattern in patterns if pattern["id"] not in moved_ids]
        await store.write_pattern_list(user_id, new_patterns)
        await store.sync_pattern_vecs(user_id, new_patterns)
    return {
        "total": len(patterns), "moved": len(valid),
        "moved_texts": moved_texts, "moved_ids": sorted(moved_ids),
        "trials_ok": ok_trials,
        "unstable": {i: v for i, v in votes.items() if v <= majority and v > 0},
    }


async def _migrate_daily(user_id: str, settings, dry_run: bool, **_ignored) -> dict:
    from agent.memory import store

    res = await store.migrate_legacy_daily(user_id, dry_run=dry_run)
    entries = res.get("entries") or []
    return {
        "migrated": res.get("migrated", 0),
        "migrated_texts": [f"{date} {note}" for date, note in entries],
    }


def _render_profile_event_block(texts: list[str]) -> str:
    lines = ["## 画像迁移补记"]
    lines.extend(f"- {text}" for text in texts)
    return "\n".join(lines).strip()


async def _migrate_profile_events(user_id: str, settings, dry_run: bool, **_ignored) -> dict:
    from agent.memory import store

    profile = await store.read_profile_list(user_id)
    if not profile:
        return {"migrated": 0}

    existing_memory = await store.read_memory_doc(user_id)
    moved_texts: list[str] = []
    keep_profile: list[dict] = []
    for item in profile:
        text = str(item.get("text") or "").strip()
        if text and _PROFILE_TEMPORAL_RE.search(text):
            moved_texts.append(text)
            continue
        keep_profile.append(item)

    if not moved_texts:
        return {"migrated": 0}

    new_memory_items = [text for text in moved_texts if text not in existing_memory]
    if not dry_run:
        await store.write_profile_list(user_id, keep_profile)
        if new_memory_items:
            blocks = [existing_memory.strip()] if existing_memory.strip() else []
            blocks.append(_render_profile_event_block(new_memory_items))
            await store.write_memory_doc(user_id, "\n\n".join(blocks))
            await store.sync_memory_vecs(user_id, "\n\n".join(blocks))
    return {
        "migrated": len(moved_texts),
        "moved_texts": moved_texts,
        "memory_appended_texts": new_memory_items,
    }


OPS = {
    "patterns": _review_patterns,
    "cleanup-legacy": _cleanup_legacy,
    "migrate-daily": _migrate_daily,
    "migrate-profile-events": _migrate_profile_events,
    "split-profile": _split_profile,
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
    ap.add_argument("--facts", action="store_true", help="旧别名：等同 --patterns")
    ap.add_argument("--trials", type=int, default=3, help="pattern 复核每个用户独立调用几次、多数票才删（默认 3）")
    ap.add_argument("--temperature", type=float, default=0.1, help="pattern 复核调用的 temperature（默认 0.1，越低越稳定）")
    args = ap.parse_args()

    if args.facts:
        args.patterns = True

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
            if res.get("removed") or res.get("moved") or res.get("migrated") or res.get("error") or res.get("unstable"):
                touched += 1
                print(f"[{op_name}] {uid}: {res}")
        print(f"[{op_name}] 完成，{len(user_ids)} 个用户里 {touched} 个有改动/有分歧")

    print("done")


if __name__ == "__main__":
    asyncio.run(main())
