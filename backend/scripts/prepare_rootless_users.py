#!/usr/bin/env python3
"""批量准备用户 Rootless Docker Shell 持久目录的 ACL。

默认只输出计划；只有显式传入 --apply 才会修改目录权限。
users_root 必须是专门的数据用户根目录，不允许传入系统根目录或用户 home 根目录。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# 该脚本由 Makefile 直接以 scripts/xxx.py 启动，此时 Python 默认只把
# scripts/ 放入 sys.path；显式加入 backend 根目录，保证 sudo make 也能导入 agent。
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.sandbox.rootless_permissions import apply_permission_plan, default_permission_plan


def discover_shell_roots(users_root: str | Path) -> tuple[Path, ...]:
    root = Path(users_root).expanduser().resolve(strict=True)
    if root == Path("/") or root.name in {"", ".", ".."}:
        raise ValueError("用户数据根目录无效")
    if not root.is_dir():
        raise ValueError("用户数据根目录必须是目录")
    result: list[Path] = []
    for user_root in sorted(root.iterdir(), key=lambda item: item.name):
        if not user_root.is_dir() or user_root.name.startswith("."):
            continue
        result.append(user_root / "shell")
    return tuple(result)


def main() -> int:
    parser = argparse.ArgumentParser(description="批量准备 Rootless Docker Shell 用户目录 ACL")
    parser.add_argument("users_root", help="专门的用户数据根目录，例如 Gugu-data/users")
    parser.add_argument("--login", default=os.environ.get("USER", ""), help="Rootless Docker 登录用户")
    parser.add_argument("--apply", action="store_true", help="实际应用 ACL；默认仅输出计划")
    args = parser.parse_args()
    if not args.login:
        parser.error("无法确定登录用户，请传入 --login")
    try:
        roots = discover_shell_roots(args.users_root)
        plans = tuple(default_permission_plan(root, login=args.login) for root in roots)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    print(f"发现 {len(plans)} 个用户 Shell 目录。")
    for plan in plans:
        print(f"\nworkspace: {plan.root}")
        print(f"container uid/gid 65532 映射到 host uid/gid: {plan.mapped_uid}:{plan.mapped_gid}")
        for command in plan.commands:
            print("  " + " ".join(command))
    if not args.apply:
        print("\n仅输出计划；需要实际修改时显式追加 --apply。")
        return 0
    try:
        for plan in plans:
            apply_permission_plan(plan)
    except (OSError, RuntimeError) as exc:
        print(f"应用失败：{exc}", file=sys.stderr)
        return 1
    print("Rootless 用户 Shell ACL 已应用。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
