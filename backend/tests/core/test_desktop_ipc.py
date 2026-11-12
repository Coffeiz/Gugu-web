"""真实桌面子进程协议：持久化、冲突、能力白名单与 EOF 回收。"""
from pathlib import Path
import json
import os
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.process


def exchange(database, requests, *, raw=None):
    env = dict(os.environ, PYTHONPATH=str(ROOT / "compat/desktop-python/python"), PYTHONUTF8="1")
    frames = raw if raw is not None else b"".join((json.dumps(item, ensure_ascii=False) + "\n").encode() for item in requests)
    result = subprocess.run(
        [sys.executable, "-m", "gugu_desktop_host", "--database", str(database)],
        input=frames, capture_output=True, timeout=20, env=env,
    )
    return result, [json.loads(line) for line in result.stdout.splitlines()]


def request(identifier, method, params=None):
    return {"v": 1, "id": identifier, "method": method, "params": params or {}}


def test_desktop_pipe_persists_rows_and_rejects_stale_rename_after_restart(tmp_path):
    path = tmp_path / "desktop.db"
    result, frames = exchange(path, [request(1, "projects.create", {"name": "桌面计划"}), request(2, "clients.create", {"name": "小北"})])
    assert result.returncode == 0
    assert result.stderr == b""
    assert frames[0] == {"v": 1, "event": "ready"}
    project = frames[1]["result"]
    result, frames = exchange(path, [
        request(3, "projects.rename", {"id": project["id"], "version": 1, "name": "更新计划"}),
        request(4, "projects.rename", {"id": project["id"], "version": 1, "name": "过期修改"}),
        request(5, "projects.list"), request(6, "clients.list"),
    ])
    assert result.returncode == 0
    assert frames[2]["error"]["code"] == "conflict"
    assert [(row["name"], row["version"]) for row in frames[3]["result"]] == [("更新计划", 2)]
    assert [row["name"] for row in frames[4]["result"]] == ["小北"]


def test_desktop_pipe_rejects_shell_fs_identity_and_unknown_protocol(tmp_path):
    _, frames = exchange(tmp_path / "scope.db", [
        request(1, "shell.run", {"command": "echo 不应执行"}),
        request(2, "fs.read", {"path": "private.txt"}),
        request(3, "projects.create", {"name": "越权计划", "owner_id": "untrusted"}),
        {"v": 2, "id": 4, "method": "projects.list", "params": {}},
        request(5, "projects.list"),
    ])
    assert all(frame["error"]["code"] == "invalid_request" for frame in frames[1:5])
    assert frames[5]["result"] == []


def test_desktop_pipe_rejects_oversized_frame_and_exits(tmp_path):
    result, frames = exchange(tmp_path / "oversized.db", [], raw=b"x" * 65_538 + b"\n")
    assert result.returncode == 2
    assert frames[-1]["error"]["code"] == "invalid_frame"
