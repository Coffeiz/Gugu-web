"""幂等补齐内置 PostgreSQL 的本机连接规则，保留已有 HBA 内容与文件元数据。"""
from __future__ import annotations

import fcntl
import os
import sys
from pathlib import Path

LOOPBACK_RULES = (
    "host all all 127.0.0.1/32 trust",
    "host all all ::1/128 trust",
)


def ensure_loopback_rules(hba_path: Path) -> None:
    """为内置依赖补充缺失规则；加锁后追加，不重写用户现有配置。"""
    with hba_path.open("a+", encoding="utf-8", newline="") as hba_file:
        fcntl.flock(hba_file.fileno(), fcntl.LOCK_EX)
        hba_file.seek(0)
        content = hba_file.read()
        existing_rules = {
            " ".join(line.split())
            for line in content.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        missing_rules = [rule for rule in LOOPBACK_RULES if rule not in existing_rules]
        if not missing_rules:
            return

        hba_file.seek(0, os.SEEK_END)
        if content and not content.endswith("\n"):
            hba_file.write("\n")
        for rule in missing_rules:
            hba_file.write(f"{rule}\n")
        hba_file.flush()
        os.fsync(hba_file.fileno())


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("用法：ensure_embedded_pg_hba.py <pg_hba.conf>")
    ensure_loopback_rules(Path(sys.argv[1]))
