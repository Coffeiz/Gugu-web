"""内置 PostgreSQL 的 HBA 规则必须兼容已有数据目录。"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENSURE_HBA_SCRIPT = REPO_ROOT / "backend" / "scripts" / "ensure_embedded_pg_hba.py"


def test_existing_hba_gets_idempotent_loopback_rules_without_rewriting_existing_rules(tmp_path):
    hba_file = tmp_path / "pg_hba.conf"
    original = (
        "# 用户原有配置必须保留\n"
        "hostssl all all all scram-sha-256\n"
    )
    hba_file.write_text(original, encoding="utf-8")
    hba_file.chmod(0o640)

    subprocess.run([sys.executable, str(ENSURE_HBA_SCRIPT), str(hba_file)], check=True)
    first_result = hba_file.read_text(encoding="utf-8")
    subprocess.run([sys.executable, str(ENSURE_HBA_SCRIPT), str(hba_file)], check=True)
    second_result = hba_file.read_text(encoding="utf-8")

    expected_rules = (
        "host all all 127.0.0.1/32 trust\n"
        "host all all ::1/128 trust\n"
    )
    assert first_result == original + expected_rules
    assert second_result == first_result
    assert hba_file.stat().st_mode & 0o777 == 0o640


def test_embedded_entrypoint_reconciles_hba_before_starting_postgres():
    entrypoint = (REPO_ROOT / "backend" / "docker-entrypoint.sh").read_text(encoding="utf-8")

    helper_call = 'python /usr/local/bin/ensure_embedded_pg_hba.py "$EMBED_DATA/postgres/pg_hba.conf"'
    assert helper_call in entrypoint
    assert entrypoint.index(helper_call) < entrypoint.index('echo "[entrypoint] 启动内置 PostgreSQL / Redis')

    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY backend/scripts/ensure_embedded_pg_hba.py /usr/local/bin/ensure_embedded_pg_hba.py" in dockerfile
