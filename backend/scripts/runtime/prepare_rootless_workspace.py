#!/usr/bin/env python3
"""准备 Rootless Docker Shell workspace 的宿主机 ACL。

默认只输出计划；只有显式传入 --apply 才会修改目录权限。
"""
from __future__ import annotations

import argparse
import os
import sys

from agent.sandbox.rootless_permissions import apply_permission_plan, default_permission_plan


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 Rootless Docker Shell workspace 权限")
    parser.add_argument("root", help="要挂载到容器 /workspace 的目录")
    parser.add_argument("--login", default=os.environ.get("USER", ""), help="Rootless Docker 登录用户")
    parser.add_argument("--apply", action="store_true", help="实际应用 ACL；默认仅打印计划")
    args = parser.parse_args()
    if not args.login:
        parser.error("无法确定登录用户，请传入 --login")
    try:
        plan = default_permission_plan(args.root, login=args.login)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    print(f"workspace: {plan.root}")
    print(f"container uid/gid 65532 映射到 host uid/gid: {plan.mapped_uid}:{plan.mapped_gid}")
    print("权限计划：")
    for command in plan.commands:
        print("  " + " ".join(command))
    if not args.apply:
        print("仅输出计划；需要实际修改时显式追加 --apply。")
        return 0
    try:
        apply_permission_plan(plan)
    except (OSError, RuntimeError) as exc:
        print(f"应用失败：{exc}", file=sys.stderr)
        return 1
    print("Rootless workspace ACL 已应用。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
