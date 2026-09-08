"""send_file 的文件库名称、file_id 与 Shell 逻辑路径回归。"""

import json
from types import SimpleNamespace

from agent.tools import files
from agent.tools.files import transfer as file_transfer


async def test_send_file_accepts_workspace_logical_path(db, user_a, tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    source = root / "F1" / "F1蒙扎-正赛-长距离图-2x.png"
    source.parent.mkdir()
    source.write_bytes(b"png-bytes")

    async def current_policy(*_args):
        return _policy()

    async def shell_root(*_args):
        return root

    monkeypatch.setattr(file_transfer, "current_filesystem_policy", current_policy)
    monkeypatch.setattr("app.services.workspaces.resolve_shell_root", shell_root)

    async def fake_stage(user_id, name, ext, mime, data, *, kind=None, **_kwargs):
        assert user_id == user_a.id
        assert (name, ext, mime, data, kind) == (
            "F1蒙扎-正赛-长距离图-2x", "png", "image/png", b"png-bytes", "image",
        )
        return {
            "attach_id": "attach-path",
            "name": name,
            "ext": ext,
            "kind": kind,
            "size": len(data),
        }

    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)
    result = await files._send_file(
        db,
        user_a.id,
        {"file": "/workspace/F1/F1蒙扎-正赛-长距离图-2x.png"},
    )

    assert result["_artifact"]["attach_id"] == "attach-path"
    assert result["_artifact"]["name"] == "F1蒙扎-正赛-长距离图-2x"


async def test_send_file_accepts_gugu_sandbox_prefix(db, user_a, tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "result.txt").write_text("done", encoding="utf-8")
    async def current_policy(*_args):
        return _policy()

    async def shell_root(*_args):
        return root

    monkeypatch.setattr(file_transfer, "current_filesystem_policy", current_policy)
    monkeypatch.setattr("app.services.workspaces.resolve_shell_root", shell_root)

    async def fake_stage(*_args, **_kwargs):
        return {"attach_id": "attach-text", "name": "result", "ext": "txt", "kind": "text", "size": 4}

    monkeypatch.setattr("app.core.chat_attach.stage", fake_stage)
    result = await files._send_file(db, user_a.id, {"file": "gugu-sandbox:/workspace/result.txt"})

    assert result["_artifact"]["attach_id"] == "attach-text"


async def test_send_file_rejects_host_path_and_parent_escape(db, user_a, monkeypatch):
    async def current_policy(*_args):
        return _policy()

    monkeypatch.setattr(file_transfer, "current_filesystem_policy", current_policy)

    host_path = await files._send_file(db, user_a.id, {"file": "/etc/passwd"})
    parent_path = await files._send_file(db, user_a.id, {"file": "/workspace/../etc/passwd"})

    assert json.loads(host_path)["error"].startswith("只允许发送")
    assert json.loads(parent_path)["error"] == "路径不能包含 . 或 .."


def _policy():
    return SimpleNamespace(full_user_sandbox=True, workspace_id=None)
