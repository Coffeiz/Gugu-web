"""本地项目数据切片的命令行宿主，不开放网络或系统执行能力。"""
from dataclasses import asdict
from pathlib import Path
import argparse
import asyncio
import json
import sys

from sqlalchemy.exc import SQLAlchemyError

from gugu_core.application.projects import ProjectConflict, ProjectNotFound
from gugu_core.data.runtime import LocalRuntime, RuntimeSchemaError


async def run(args) -> None:
    if args.command == "init":
        runtime = await LocalRuntime.initialize(args.database)
    else:
        runtime = await LocalRuntime.open(args.database)
    try:
        async with runtime.transaction() as projects:
            if args.command == "init":
                result = {"initialized": True}
            elif args.command == "list":
                result = [asdict(project) for project in await projects.list(archived=args.archived)]
            elif args.command == "create":
                result = asdict(await projects.create({"name": args.name}))
            else:
                result = asdict(await projects.update(args.id, args.version, {"name": args.name}))
        print(json.dumps(result, ensure_ascii=False, default=str))
    finally:
        await runtime.close()


def main() -> None:
    # Windows 的重定向输出可能使用系统代码页；IPC/脚本读取统一采用 UTF-8。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Core 本地项目数据运行时（实验性）")
    parser.add_argument("--database", type=Path, required=True, help="显式指定 SQLite 文件")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="初始化全新数据库，不覆盖已有文件")
    commands.add_parser("list", help="列出项目").add_argument("--archived", action="store_true")
    commands.add_parser("create", help="创建项目").add_argument("name")
    rename = commands.add_parser("rename", help="按版本修改项目名称")
    rename.add_argument("id", type=int)
    rename.add_argument("name")
    rename.add_argument("--version", required=True, type=int)
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except (ProjectConflict, ProjectNotFound, RuntimeSchemaError, ValueError) as exc:
        # 领域错误只含受控文案；不输出数据库/系统异常和用户输入。
        parser.exit(2, f"{exc}\n")
    except OSError:
        parser.exit(2, "数据库文件无法访问，请检查路径或是否已经初始化\n")
    except SQLAlchemyError:
        parser.exit(2, "数据库操作失败，请检查文件格式、完整性和并发访问状态\n")


if __name__ == "__main__":
    main()
