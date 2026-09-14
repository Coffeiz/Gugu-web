from __future__ import annotations

import io
import stat
import struct
import tarfile
import zipfile

import pytest
from sqlalchemy import select

from app.core.errors import Conflict, Invalid, NotFound
from app.models import File, Folder, Project
from app.services.files.archive import compress_files, extract_file
from app.services.storage import LocalStorageBackend


async def _file(db, storage, user_id, name, data, *, folder_id=None, folder_path=""):
    display_name, dot, ext = name.rpartition(".")
    if not dot:
        display_name, ext = name, ""
    filename = f"{display_name}.{ext}" if ext else display_name
    key = f"{user_id}/个人文件/{folder_path}{filename}"
    await storage.put(key, data, "application/octet-stream")
    row = File(
        user_id=user_id, display_name=display_name, ext=ext, space="personal",
        folder_id=folder_id, storage_key=key, size_bytes=len(data),
        size=f"{len(data)} B", mime_type="application/octet-stream",
    )
    db.add(row)
    await db.flush()
    return row


@pytest.mark.asyncio
async def test_compress_mixed_items_keeps_cjk_and_empty_directories(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    root = Folder(user_id=user_a.id, name="资料")
    empty = Folder(user_id=user_a.id, name="空目录", parent=root)
    db.add_all([root, empty])
    await db.flush()
    source = await _file(db, storage, user_a.id, "中文 文件.txt", "内容".encode(),
                         folder_id=root.id, folder_path="资料/")
    top = await _file(db, storage, user_a.id, "说明.md", b"readme")

    archive_file = await compress_files(
        db, user_a.id, file_ids=[top.id], folder_ids=[root.id], storage=storage,
    )
    await db.commit()

    payload = await storage.get(archive_file.storage_key)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        assert "说明.md" in archive.namelist()
        assert "资料/中文 文件.txt" in archive.namelist()
        assert "资料/空目录/" in archive.namelist()
        assert archive.read("资料/中文 文件.txt") == "内容".encode()
    assert archive_file.ext == "zip"
    assert archive_file.mime_type == "application/zip"
    assert archive_file.folder_id is None
    assert source.id != top.id


@pytest.mark.asyncio
async def test_compress_enforces_source_limit_and_empty_selection(db, user_a, tmp_path, monkeypatch):
    from app.services.files import archive as archive_service

    storage = LocalStorageBackend(tmp_path / "storage")
    source = await _file(db, storage, user_a.id, "big.bin", b"1234")
    monkeypatch.setattr(archive_service, "MAX_COMPRESS_SOURCE_BYTES", 3)
    with pytest.raises(Conflict, match="内容过大"):
        await compress_files(db, user_a.id, file_ids=[source.id], storage=storage)
    with pytest.raises(Invalid, match="请先选择"):
        await compress_files(db, user_a.id, storage=storage)


def test_archive_limits_match_prd_contract():
    from app.services.files.archive import (
        MAX_ARCHIVE_ENTRIES,
        MAX_COMPRESS_SOURCE_BYTES,
        MAX_EXTRACT_BYTES,
    )

    assert MAX_COMPRESS_SOURCE_BYTES == 512 * 1024 * 1024
    assert MAX_EXTRACT_BYTES == 2 * 1024 * 1024 * 1024
    assert MAX_ARCHIVE_ENTRIES == 10_000


@pytest.mark.asyncio
async def test_extract_zip_renames_existing_names_and_preserves_tree(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    existing_folder = Folder(user_id=user_a.id, name="目录")
    db.add(existing_folder)
    await db.flush()
    await _file(db, storage, user_a.id, "重复.txt", b"existing")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("重复.txt", b"first")
        archive.writestr("重复.txt", b"second")
        archive.writestr("目录/内部.txt", b"nested")
        archive.writestr("空/", b"")
    zip_file = await _file(db, storage, user_a.id, "资料.zip", buffer.getvalue())

    summary = await extract_file(db, user_a.id, zip_file.id, storage=storage)
    await db.commit()

    extracted = list((await db.execute(select(File).where(
        File.user_id == user_a.id, File.id != zip_file.id,
    ))).scalars().all())
    extracted_names = {(row.display_name, row.ext) for row in extracted}
    assert ("重复 (2)", "txt") in extracted_names
    assert ("重复 (3)", "txt") in extracted_names
    assert ("内部", "txt") in extracted_names
    assert summary["file_count"] == 3
    assert summary["folder_count"] == 2
    assert summary["created_count"] == 5
    assert len(summary["file_ids"]) == summary["file_count"]
    assert len(summary["folder_ids"]) == summary["folder_count"]
    assert {row.name for row in (await db.execute(select(Folder))).scalars()} >= {"目录 (2)", "空"}
    contents = {row.display_name: await storage.get(row.storage_key) for row in extracted}
    assert contents["重复 (2)"] == b"first"
    assert contents["重复 (3)"] == b"second"
    assert contents["内部"] == b"nested"


@pytest.mark.asyncio
async def test_extract_creates_named_folder_next_to_archive_and_renames_collision(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    parent = Folder(user_id=user_a.id, name="素材")
    db.add(parent)
    await db.flush()
    existing = Folder(user_id=user_a.id, name="资料", parent_id=parent.id)
    db.add(existing)
    await db.flush()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("说明.txt", b"inside")
    zip_file = await _file(
        db, storage, user_a.id, "资料.zip", buffer.getvalue(),
        folder_id=parent.id, folder_path="素材/",
    )

    summary = await extract_file(
        db, user_a.id, zip_file.id, folder_name="资料", storage=storage,
    )
    await db.commit()

    created_root = await db.get(Folder, summary["folder_ids"][0])
    extracted = await db.get(File, summary["file_ids"][0])
    assert created_root is not None
    assert created_root.name == "资料 (2)"
    assert created_root.parent_id == parent.id
    assert extracted is not None
    assert extracted.folder_id == created_root.id
    assert extracted.storage_key.endswith("素材/资料 (2)/说明.txt")
    assert summary["folder_count"] == 1
    assert summary["created_count"] == 2


@pytest.mark.asyncio
async def test_extract_maps_single_archive_root_to_custom_output_folder_without_duplicate_empty_folder(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("0824照片BG数据/", "")
        for index in range(11):
            archive.writestr(f"0824照片BG数据/图片-{index}.jpg", b"image")
    zip_file = await _file(db, storage, user_a.id, "0824照片BG数据.zip", buffer.getvalue())

    summary = await extract_file(
        db, user_a.id, zip_file.id, folder_name="解压结果", storage=storage,
    )
    await db.commit()

    output_folder = await db.get(Folder, summary["folder_ids"][0])
    extracted = (await db.execute(select(File).where(
        File.user_id == user_a.id, File.id != zip_file.id,
    ))).scalars().all()
    assert output_folder is not None and output_folder.name == "解压结果"
    assert summary["folder_count"] == 1
    assert summary["file_count"] == 11
    assert all(file.folder_id == output_folder.id for file in extracted)
    created_folders = (await db.execute(select(Folder))).scalars().all()
    assert created_folders == [output_folder]


@pytest.mark.parametrize("folder_name", ["", "..", "../escape", "C:folder", "x" * 201])
@pytest.mark.asyncio
async def test_extract_rejects_invalid_output_folder_name_without_creating_rows(
    db, user_a, tmp_path, folder_name,
):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("ok.txt", b"ok")
    zip_file = await _file(db, storage, user_a.id, "资料.zip", buffer.getvalue())
    before_folders = len((await db.execute(select(Folder))).scalars().all())
    before_files = len((await db.execute(select(File))).scalars().all())

    with pytest.raises(Invalid, match="解压文件夹名称无效"):
        await extract_file(db, user_a.id, zip_file.id, folder_name=folder_name, storage=storage)

    assert len((await db.execute(select(Folder))).scalars().all()) == before_folders
    assert len((await db.execute(select(File))).scalars().all()) == before_files


@pytest.mark.asyncio
async def test_extract_tar_gz_and_skip_links(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        content = b"hello tar"
        info = tarfile.TarInfo("子目录/问候.txt")
        info.size = len(content)
        archive.addfile(info, io.BytesIO(content))
        link = tarfile.TarInfo("子目录/链接")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../outside"
        archive.addfile(link)
    tar_file = await _file(db, storage, user_a.id, "备份.tar.gz", buffer.getvalue())

    summary = await extract_file(db, user_a.id, tar_file.id, storage=storage)
    await db.commit()

    extracted = (await db.execute(select(File).where(File.id != tar_file.id))).scalars().all()
    assert len(extracted) == 1
    assert await storage.get(extracted[0].storage_key) == b"hello tar"
    assert summary["skipped_count"] == 1


@pytest.mark.parametrize("entry_name", [
    "../escape.txt", "/absolute.txt", "C:/drive.txt", "./C:/normalized-drive.txt",
])
@pytest.mark.asyncio
async def test_extract_rejects_zip_slip_before_creating_any_entry(db, user_a, tmp_path, entry_name):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("safe.txt", b"safe")
        archive.writestr(entry_name, b"no")
    zip_file = await _file(db, storage, user_a.id, "unsafe.zip", buffer.getvalue())
    before_files = len((await db.execute(select(File))).scalars().all())

    with pytest.raises(Invalid, match="压缩包损坏"):
        await extract_file(db, user_a.id, zip_file.id, storage=storage)

    assert len((await db.execute(select(File))).scalars().all()) == before_files
    assert await storage.exists(f"{user_a.id}/个人文件/escape.txt") is False


@pytest.mark.asyncio
async def test_extract_skips_zip_symlink_and_rejects_bomb_metadata(db, user_a, tmp_path, monkeypatch):
    from app.services.files import archive as archive_service

    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("ok.txt", b"ok")
        symlink = zipfile.ZipInfo("link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(symlink, "../../outside")
    zip_file = await _file(db, storage, user_a.id, "links.zip", buffer.getvalue())
    summary = await extract_file(db, user_a.id, zip_file.id, storage=storage)
    assert summary["skipped_count"] == 1

    bomb_buffer = io.BytesIO()
    with zipfile.ZipFile(bomb_buffer, "w") as archive:
        archive.writestr("large.txt", b"12345")
    bomb_file = await _file(db, storage, user_a.id, "large.zip", bomb_buffer.getvalue())
    monkeypatch.setattr(archive_service, "MAX_EXTRACT_BYTES", 4)
    with pytest.raises(Conflict, match="超过可用存储空间"):
        await extract_file(db, user_a.id, bomb_file.id, storage=storage)


@pytest.mark.asyncio
async def test_extract_rejects_too_many_entries_before_writing(db, user_a, tmp_path, monkeypatch):
    from app.services.files import archive as archive_service

    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("one.txt", b"1")
        archive.writestr("two.txt", b"2")
    zip_file = await _file(db, storage, user_a.id, "many.zip", buffer.getvalue())
    monkeypatch.setattr(archive_service, "MAX_ARCHIVE_ENTRIES", 1)
    before_files = len((await db.execute(select(File))).scalars().all())

    with pytest.raises(Conflict, match="条目过多"):
        await extract_file(db, user_a.id, zip_file.id, storage=storage)

    assert len((await db.execute(select(File))).scalars().all()) == before_files


@pytest.mark.asyncio
async def test_extract_rejects_unsupported_archive_extension(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    source = await _file(db, storage, user_a.id, "unknown.rar", b"not a supported archive")

    with pytest.raises(Invalid, match="不支持的压缩格式"):
        await extract_file(db, user_a.id, source.id, storage=storage)


@pytest.mark.asyncio
async def test_extract_checks_live_quota_before_writing(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("payload.txt", b"four")
    payload = buffer.getvalue()
    archive_file = await _file(db, storage, user_a.id, "quota.zip", payload)
    user_a.storage_limit_bytes = len(payload) + 3
    await db.flush()
    before_files = len((await db.execute(select(File))).scalars().all())

    with pytest.raises(Conflict, match="超过可用存储空间"):
        await extract_file(db, user_a.id, archive_file.id, storage=storage)

    assert len((await db.execute(select(File))).scalars().all()) == before_files
    assert await storage.exists(f"{user_a.id}/个人文件/payload.txt") is False


@pytest.mark.asyncio
async def test_compress_rejects_cross_space_and_unowned_sources(db, user_a, user_b, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    personal = await _file(db, storage, user_a.id, "mine.txt", b"mine")
    project = Project(user_id=user_a.id, name="项目")
    db.add(project)
    await db.flush()
    project_file = File(
        user_id=user_a.id, display_name="project", ext="txt", space="project",
        project_id=project.id, storage_key=f"{user_a.id}/project.txt", size_bytes=1,
    )
    db.add(project_file)
    await db.flush()
    other = await _file(db, storage, user_b.id, "private.txt", b"private")

    with pytest.raises(Invalid, match="不能跨空间"):
        await compress_files(db, user_a.id, file_ids=[personal.id, project_file.id], storage=storage)
    with pytest.raises(NotFound, match="所选文件或文件夹不存在"):
        await compress_files(db, user_a.id, file_ids=[other.id], storage=storage)


@pytest.mark.asyncio
async def test_corrupt_crc_rolls_back_all_files_and_folders(db, user_a, tmp_path):
    storage = LocalStorageBackend(tmp_path / "storage")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("first.txt", b"first")
        archive.writestr("nested/second.txt", b"second")
    raw = bytearray(buffer.getvalue())
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        second = archive.getinfo("nested/second.txt")
        offset = second.header_offset
        name_length, extra_length = struct.unpack_from("<HH", raw, offset + 26)
        payload_offset = offset + 30 + name_length + extra_length
        raw[payload_offset] ^= 0x01
    zip_file = await _file(db, storage, user_a.id, "broken.zip", bytes(raw))
    before_files = len((await db.execute(select(File))).scalars().all())

    with pytest.raises(Invalid, match="压缩包损坏"):
        await extract_file(db, user_a.id, zip_file.id, storage=storage)

    assert len((await db.execute(select(File))).scalars().all()) == before_files
    assert (await db.execute(select(Folder))).scalars().all() == []
    assert await storage.exists(f"{user_a.id}/个人文件/first.txt") is False
