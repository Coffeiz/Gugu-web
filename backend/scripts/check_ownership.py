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

TOOLS_DIR = Path(__file__).parent.parent / "agent" / "tools"
EXEMPT_MARK = "ownership-exempt"
BARE_GET = re.compile(r"\bdb\.get\(")


def main() -> int:
    violations: list[str] = []
    for py in sorted(TOOLS_DIR.glob("*.py")):
        for lineno, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):          # 纯注释行（含解释老模式的文档注释）不算
                continue
            if BARE_GET.search(line) and EXEMPT_MARK not in line:
                violations.append(f"{py.relative_to(TOOLS_DIR.parent.parent)}:{lineno}: {stripped[:100]}")
    if violations:
        print("❌ 发现裸 db.get()（应改用 app.core.ownership.get_owned，或加 # ownership-exempt 标记说明豁免理由）：")
        for v in violations:
            print("  " + v)
        return 1
    print("✅ ownership 守卫通过：agent/tools/ 无裸 db.get()")
    return 0


if __name__ == "__main__":
    sys.exit(main())
