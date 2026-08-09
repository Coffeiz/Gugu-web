from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _fake_systemctl(tmp_path: Path) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "systemctl"
    script.write_text(
        """#!/bin/sh
if [ \"$1\" = \"is-active\" ] && [ \"$3\" = \"gugu-worker\" ] && [ \"${FAKE_SYSTEMD_INACTIVE:-0}\" = \"1\" ]; then
  exit 3
fi
exit 0
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _run_start(fake_bin: Path, *, inactive: bool) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["GUGU_SERVICE_MODE"] = "systemd"
    env["GUGU_SYSTEMD_CHECK_ATTEMPTS"] = "1"
    env["FAKE_SYSTEMD_INACTIVE"] = "1" if inactive else "0"
    return subprocess.run(
        [str(ROOT / "start.sh"), "start"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_systemd_start_fails_when_worker_is_not_active(tmp_path: Path):
    result = _run_start(_fake_systemctl(tmp_path), inactive=True)

    assert result.returncode != 0
    assert "systemd 服务未全部处于 active 状态" in result.stdout


def test_systemd_start_succeeds_when_all_services_are_active(tmp_path: Path):
    result = _run_start(_fake_systemctl(tmp_path), inactive=False)

    assert result.returncode == 0
