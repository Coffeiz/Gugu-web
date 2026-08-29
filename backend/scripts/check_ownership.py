#!/usr/bin/env python3
"""多用户隔离静态守卫：agent/tools/ 下禁止裸 db.get()。

背景（商用就绪评审 P0-2）：按主键取「有归属的行」必须走 app/core/ownership.py 的
get_owned()（取行 + 归属校验 + 越权日志一体），不允许业务代码裸调 db.get() 再手写
if 校验——那种模式少一行 if 就是越权漏洞。本脚本抓的就是"新代码又写回老模式"。

确实无归属语义的行（如按本人 id 取本人 User 行）在该行行尾加标记豁免：
    obj = await db.get(User, user_id)   # ownership-exempt: 为什么豁免

用法：python scripts/check_ownership.py   （干净退出 0；有违规打印清单退出 1）
接 CI 后作为门禁；本地提交前跑一次也行。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BACKEND = Path(__file__).parent.parent
# 受守卫的目录：agent 工具层 + 用户态 REST 层
GUARDED_DIRS = [BACKEND / "agent" / "tools", BACKEND / "app" / "api" / "v1"]
# REST 层里整文件豁免的（管理员合法跨用户访问 / 无归属语义的模型）：
#   auth.py         按 token 取本人 User 行（User 无 user_id 列）
#   config.py       管理员改配置时确认用户存在
#   *_admin.py      管理员后台（用户管理/会话轨迹/站内通知），本就跨用户
ADMIN_EXEMPT_FILES = {"auth.py", "config.py", "agent_admin.py", "users_admin.py",
                      "notifications_admin.py", "admin_analytics.py"}
EXEMPT_MARK = "ownership-exempt"
BARE_GET = re.compile(r"\bdb\.get\(")


def main() -> int:
    violations: list[str] = []
    for d in GUARDED_DIRS:
        for py in sorted(d.glob("*.py")):
            if py.name in ADMIN_EXEMPT_FILES or py.name.startswith("._"):   # ._* = macOS AppleDouble 残留（SMB 时代遗产），非代码
                continue
            for lineno, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):          # 纯注释行（含解释老模式的文档注释）不算
                    continue
                if BARE_GET.search(line) and EXEMPT_MARK not in line:
                    violations.append(f"{py.relative_to(BACKEND)}:{lineno}: {stripped[:100]}")
    if violations:
        print("❌ 发现裸 db.get()（应改用 app.core.ownership.get_owned，或加 # ownership-exempt 标记说明豁免理由）：")
        for v in violations:
            print("  " + v)
        return 1
    print("✅ ownership 守卫通过：agent/tools/ 与 app/api/v1/（用户态）无裸 db.get()")
    return 0


if __name__ == "__main__":
    sys.exit(main())
