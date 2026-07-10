#!/usr/bin/env python3
"""统一时钟静态守卫：业务代码禁止裸调 datetime.utcnow()（见 docs/backend/时区与时钟迁移方案.md）。

背景（时区迁移 Phase 4）：`datetime.utcnow()` 已弃用（Python 3.14 持续告警）且返回 naive UTC，
与全站 aware-UTC 列语义不符。当前时间一律走 `app.core.tz.now_utc()`（aware UTC 单一出口）。
本脚本抓「新代码又写回 utcnow」——含裸调用 `datetime.utcnow()` 与函数引用 `default=datetime.utcnow`。

确有理由的例外，在该行行尾加标记豁免：
    x = datetime.utcnow()   # utcnow-exempt: 为什么

用法：python scripts/check_utcnow.py   （干净退出 0；有违规打印清单退出 1）。接 CI 门禁。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BACKEND = Path(__file__).parent.parent
GUARDED_DIRS = [BACKEND / "app", BACKEND / "agent", BACKEND / "onboarding"]
# tz.py 是时钟出口本身，docstring 里合法引用 utcnow 名字；tests/ 不在守卫范围（fixture 另清）
EXEMPT_FILES = {"tz.py"}
EXEMPT_MARK = "utcnow-exempt"
UTCNOW = re.compile(r"\.utcnow\b")


def main() -> int:
    violations: list[str] = []
    for base in GUARDED_DIRS:
        if not base.exists():
            continue
        for py in base.rglob("*.py"):
            if py.name in EXEMPT_FILES or "__pycache__" in py.parts:
                continue
            for lineno, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):          # 纯注释/文档行不算
                    continue
                if UTCNOW.search(line) and EXEMPT_MARK not in line:
                    violations.append(f"{py.relative_to(BACKEND)}:{lineno}: {stripped[:100]}")
    if violations:
        print("❌ 发现裸 datetime.utcnow（应改用 app.core.tz.now_utc，或加 # utcnow-exempt 标记说明理由）：")
        for v in violations:
            print("  " + v)
        return 1
    print("✅ 时钟守卫通过：app/ agent/ onboarding/ 无裸 datetime.utcnow")
    return 0


if __name__ == "__main__":
    sys.exit(main())
