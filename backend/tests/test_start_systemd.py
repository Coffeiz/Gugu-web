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
if [ \"$1\" = \"is-active\" ] && [ \"$3\" = \"gugu-worker\" ] && [ \"${FAKE_SYSTEMD_DROP_AFTER_FIRST:-0}\" = \"1\" ]; then
  count=0
  [ -f \"$FAKE_SYSTEMD_STATE\" ] && count=$(cat \"$FAKE_SYSTEMD_STATE\")
  count=$((count + 1))
  printf '%s' \"$count\" > \"$FAKE_SYSTEMD_STATE\"
  [ \"$count\" -gt 1 ] && exit 3
fi
exit 0
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return bin_dir


def _run_start(
    fake_bin: Path,
    *,
    inactive: bool,
    drop_after_first: bool = False,
    state_file: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["GUGU_SERVICE_MODE"] = "systemd"
    env["GUGU_SYSTEMD_CHECK_ATTEMPTS"] = "3"
    env["GUGU_SYSTEMD_STABLE_CHECKS"] = "3"
    env["GUGU_SYSTEMD_CHECK_DELAY"] = "0"
    # 单测只验证 systemd 生命周期检查；提权入口由真实部署环境负责，避免测试调用本机 sudo。
    env["GUGU_SYSTEMD_PRIV_ESCALATED"] = "1"
    env["FAKE_SYSTEMD_INACTIVE"] = "1" if inactive else "0"
    env["FAKE_SYSTEMD_DROP_AFTER_FIRST"] = "1" if drop_after_first else "0"
    if state_file is not None:
        env["FAKE_SYSTEMD_STATE"] = str(state_file)
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


def test_systemd_start_fails_when_worker_drops_after_first_active_check(tmp_path: Path):
    result = _run_start(
        _fake_systemctl(tmp_path),
        inactive=False,
        drop_after_first=True,
        state_file=tmp_path / "systemctl-state",
    )

    assert result.returncode != 0
    assert "systemd 服务未全部处于 active 状态" in result.stdout
