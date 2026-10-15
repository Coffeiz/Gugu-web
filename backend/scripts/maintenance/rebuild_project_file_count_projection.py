"""重建项目卡片文件数投影。

默认只显示影响；确认后从 backend 目录运行：
    PYTHONPATH=. .venv/bin/python -m scripts.maintenance.rebuild_project_file_count_projection --apply

应用时会在一个事务里暂时阻挡文件写入，直到项目文件计数扫描和投影重建完成。
"""
import argparse
import asyncio

from app.db.project_file_counts import rebuild_project_file_count_projection
from app.db.session import get_db


async def _run() -> int:
    async for db in get_db():
        count = await rebuild_project_file_count_projection(db)
        return count
    raise RuntimeError("无法建立数据库会话")


def main() -> None:
    parser = argparse.ArgumentParser(description="重建项目卡片的项目文件数投影")
    parser.add_argument(
        "--apply", action="store_true",
        help="扫描项目文件并重建投影；执行期间会短暂阻挡文件写入",
    )
    args = parser.parse_args()
    if not args.apply:
        print("当前为预览模式；加 --apply 后会扫描活动项目文件并重建计数投影。")
        return
    count = asyncio.run(_run())
    print(f"项目文件数投影已重建，包含文件的项目数：{count}")


if __name__ == "__main__":
    main()
