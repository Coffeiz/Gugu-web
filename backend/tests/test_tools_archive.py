"""咕咕文件归档工具：schema、归属边界、共享服务调用与错误透出。"""
import io
import json
import zipfile

import pytest

from agent.tools.files.documents import FilesSkill
from agent.tools.base import registry
from agent.tools.files.transfer import _compress_files, _extract_files
from app.core.events import RESOURCE_BY_TOOL
from app.models import File
from app.services.files import archive as archive_service
from app.services.storage import LocalStorageBackend


@pytest.fixture
def storage(tmp_path, monkeypatch):
    backend = LocalStorageBackend(tmp_path)
    monkeypatch.setattr(archive_service, "get_storage", lambda: backend)
    return backend


async def _file(db, storage, user, name, content):
    display_name, ext = name.rsplit(".", 1)
    key = f"{user.id}/个人文件/{name}"
    await storage.put(key, content, "application/octet-stream")
    row = File(
        user_id=user.id, display_name=display_name, ext=ext, space="personal",
        storage_key=key, size_bytes=len(content), size=f"{len(content)} B",
        mime_type="application/octet-stream",
    )
    db.add(row)
    await db.flush()
    return row


def test_archive_tools_are_registered_with_typed_entries_and_no_confirmation():
    tools = {tool.name: tool for tool in FilesSkill.tools}
    compress = tools["compress_files"]
    extract = tools["extract_files"]
    entries = compress.input_schema["properties"]["entries"]["items"]

    assert entries["properties"]["kind"]["enum"] == ["file", "folder"]
    assert entries["required"] == ["kind", "id"]
    assert compress.mutates and extract.mutates
    assert not compress.destructive and not compress.requires_confirmation
    assert not extract.destructive and not extract.requires_confirmation
    assert "compress_files" in RESOURCE_BY_TOOL and "extract_files" in RESOURCE_BY_TOOL
    assert "512MB" in compress.description and "不覆盖" in compress.description


async def test_compress_and_extract_dispatch_publish_and_share_archive_service(
    db, user_a, storage, monkeypatch,
):
    source = await _file(db, storage, user_a, "文档.txt", "工具归档".encode())
    await db.commit()
    published = []

    async def capture(*args, **kwargs):
        published.append((args, kwargs))

    monkeypatch.setattr("app.core.events.publish", capture)
    raw, artifact = await registry.dispatch(user_a.id, "compress_files", {
        "entries": [{"kind": "file", "id": source.id}], "name": "工具结果",
    })
    compressed = json.loads(raw)
    assert artifact is None
    assert compressed["success"] is True
    assert compressed["name"] == "工具结果.zip"
    assert published[0][0][:2] == (user_a.id, "files")
    assert published[0][1]["file_op"] is None

    raw, artifact = await registry.dispatch(user_a.id, "extract_files", {
        "file_id": compressed["file_id"],
    })
    extracted = json.loads(raw)
    assert artifact is None
    assert extracted["success"] is True
    assert extracted["created_count"] == 1
    assert extracted["file_count"] == 1 and extracted["folder_count"] == 0
    assert len(extracted["file_ids"]) == 1
    assert len(published) == 2
    assert published[1][0][:2] == (user_a.id, "files")
    assert published[1][1]["file_op"] is None


async def test_archive_tool_returns_domain_error_without_exposing_foreign_data(
    db, user_a, user_b, storage,
):
    foreign = await _file(db, storage, user_b, "私有.txt", "不应泄漏".encode())
    result = await _compress_files(db, user_a.id, {
        "entries": [{"kind": "file", "id": foreign.id}],
    })
    assert result == {"error": "所选文件或文件夹不存在"}


async def test_extract_tool_reports_unsupported_format(db, user_a, storage):
    archive = await _file(db, storage, user_a, "资料.rar", b"not an archive")
    result = await _extract_files(db, user_a.id, {"file_id": archive.id})
    assert result == {"error": "不支持的压缩格式"}


async def test_extract_tool_returns_bounded_id_samples(db, user_a, storage):
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as archive:
        for index in range(105):
            archive.writestr(f"文件-{index}.txt", str(index))
    source = await _file(db, storage, user_a, "批量.zip", content.getvalue())

    result = await _extract_files(db, user_a.id, {"file_id": source.id})

    assert result["created_count"] == 105
    assert len(result["file_ids"]) == 100
    assert result["ids_truncated"] is True
