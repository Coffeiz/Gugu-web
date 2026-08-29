#!/usr/bin/env python3
"""部署前只读检查 PDF 转换器和中文字体是否可用。"""

from __future__ import annotations

import shutil
import subprocess
import sys


def run(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    return (result.stdout or result.stderr).strip()


def main() -> int:
    missing = [name for name in ("libreoffice", "fc-match") if shutil.which(name) is None]
    if missing:
        print("缺少命令: " + ", ".join(missing))
        return 1

    print("LibreOffice: " + (run("libreoffice", "--version") or "未知版本"))
    font = run("fc-match", "-f", "%{family} | %{file}\\n", ":lang=zh-cn")
    print("中文字体: " + (font or "未匹配到"))
    if not font or "Noto Sans" in font and "CJK" not in font:
        print("警告: 当前匹配结果可能不含完整 CJK 字形，请安装 fonts-noto-cjk 或等效字体。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
