"""一次性数据迁移：ScheduledTask.context_config.tool_groups 里的旧值 "search" 改成 "web_search"。

背景：agent/tools/search.py 的 SearchSkill 组名从 "search" 改成 "web_search"（跟新增的
agent/tools/global_search.py 的 GlobalSearchSkill 撞名太像，改名区分，见 2026-07-10）。
在这之前创建/编辑过的定时任务，若 classify_context_config 判断出了 tool_groups 且包含
"search"，改名后 registry.tools_of() 对不认识的旧组名会静默返回空（不报错），任务会悄悄
失去联网搜索能力。跑一次这个脚本把存量数据改过来，之后就不用在 runner.py 里挂运行时兼容映射。

跑法：
    cd backend && .venv/bin/python scripts/rename_search_tool_group.py --dry-run   # 先看会改哪些
    cd backend && .venv/bin/python scripts/rename_search_tool_group.py             # 真的写
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/ 入 path

_OLD = "search"
_NEW = "web_search"


def _renamed_groups(groups: list) -> list | None:
    """把 tool_groups 里的旧组名换成新组名，顺带去重；不含旧组名时返回 None（不用改）。"""
    if _OLD not in groups:
        return None
    renamed = [_NEW if g == _OLD else g for g in groups]
    seen = set()
    return [g for g in renamed if not (g in seen or seen.add(g))]


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="只打印会改哪些任务，不实际写")
    args = ap.parse_args()

    from app.db.session import get_db
    from app.models import ScheduledTask
    from sqlalchemy import select

    async for db in get_db():
        rows = (await db.execute(select(ScheduledTask))).scalars().all()
        touched = 0
        for t in rows:
            cfg = t.context_config
            if not isinstance(cfg, dict):
                continue
            groups = cfg.get("tool_groups")
            if not isinstance(groups, list):
                continue
            new_groups = _renamed_groups(groups)
            if new_groups is None:
                continue
            touched += 1
            print(f"任务 #{t.id}（user_id={t.user_id}）「{t.name}」：{groups} → {new_groups}")
            if not args.dry_run:
                cfg["tool_groups"] = new_groups
                t.context_config = dict(cfg)   # 整体重赋值，确保 JSON 列被标记为已修改
        if not args.dry_run and touched:
            await db.commit()
        print(f"共 {len(rows)} 条定时任务，{touched} 条命中旧组名「{_OLD}」"
              f"{'（dry-run，未实际写）' if args.dry_run else '，已更新' if touched else ''}")
        return


if __name__ == "__main__":
    asyncio.run(main())
