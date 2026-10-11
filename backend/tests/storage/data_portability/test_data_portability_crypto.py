import io
import hashlib
import json
import zipfile
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.services.data_portability.crypto_stream import (
    EncryptedArchiveReader,
    EncryptedArchiveWriter,
)
from app.services.data_portability.archive import ArchiveProducer, build_encrypted_archive
from app.services.data_portability.archive_validation import validate_encrypted_archive


@pytest.fixture
def portability_key(monkeypatch):
    import app.services.data_portability.crypto_stream as crypto_stream

    monkeypatch.setattr(
        crypto_stream,
        "get_settings",
        lambda: SimpleNamespace(secret_key="test-only-data-portability-key"),
    )


def test_encrypted_zip_round_trips_with_random_access_without_plaintext_artifact(portability_key) -> None:
    secret_content = b"synthetic-private-content:" + b"x" * (2 * 1024 * 1024 + 317)
    encrypted = io.BytesIO()
    writer = EncryptedArchiveWriter(encrypted, "owner/job-fixture", chunk_size=65536)
    with zipfile.ZipFile(writer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("records/projects.jsonl", secret_content)
    writer.finish()

    ciphertext = encrypted.getvalue()
    assert secret_content[:64] not in ciphertext
    encrypted.seek(0)
    reader = EncryptedArchiveReader(encrypted, "owner/job-fixture", chunk_size=65536)
    with zipfile.ZipFile(reader, mode="r") as archive:
        assert archive.namelist() == ["records/projects.jsonl"]
        with archive.open("records/projects.jsonl") as entry:
            assert entry.read() == secret_content


def test_encrypted_container_rejects_other_task_context(portability_key) -> None:
    encrypted = io.BytesIO()
    writer = EncryptedArchiveWriter(encrypted, "owner/job-a", chunk_size=4096)
    writer.write(b"private")
    writer.finish()
    encrypted.seek(0)

    with pytest.raises(ValueError, match="不属于当前任务"):
        EncryptedArchiveReader(encrypted, "owner/job-b", chunk_size=4096)


def test_encrypted_container_detects_tampered_ciphertext(portability_key) -> None:
    encrypted = io.BytesIO()
    writer = EncryptedArchiveWriter(encrypted, "owner/job-tamper", chunk_size=4096)
    writer.write(b"important archive data")
    writer.finish()
    raw = bytearray(encrypted.getvalue())
    raw[130] ^= 1
    encrypted = io.BytesIO(raw)
    reader = EncryptedArchiveReader(encrypted, "owner/job-tamper", chunk_size=4096)

    with pytest.raises(ValueError, match="内容校验失败"):
        reader.read()


@pytest.mark.asyncio
async def test_archive_builder_writes_streaming_entries_and_consistent_manifest(portability_key) -> None:
    record_bytes = (
        b'{"record_schema":"gugu.project.v1","portable_id":"p-1",'
        b'"source_type":"project","fields":{"name":"demo"},"relations":[]}\n'
    )

    async def write_record(stream):
        stream.write(record_bytes)
        return 1

    encrypted = io.BytesIO()
    size, digest, manifest = await build_encrypted_archive(
        encrypted,
        context="owner/export-fixture",
        origin_id=uuid4(),
        export_id=uuid4(),
        producers=[ArchiveProducer("records/projects.jsonl", "projects", write_record)],
        complete=False,
    )
    ciphertext = encrypted.getvalue()
    assert size == len(ciphertext)
    assert digest == hashlib.sha256(ciphertext).hexdigest()
    assert manifest.categories["projects"].records == 1
    assert manifest.categories["projects"].bytes == len(record_bytes)

    with zipfile.ZipFile(EncryptedArchiveReader(io.BytesIO(ciphertext), "owner/export-fixture")) as archive:
        assert archive.read("records/projects.jsonl") == record_bytes
        stored_manifest = json.loads(archive.read("manifest.json"))
        assert stored_manifest["export_id"] == str(manifest.export_id)
        checksum_entries = archive.read("checksums.sha256").decode().splitlines()
        assert any(line.endswith("  records/projects.jsonl") for line in checksum_entries)

    validation = validate_encrypted_archive(io.BytesIO(ciphertext), context="owner/export-fixture")
    assert validation.record_count == 1
    assert validation.manifest.export_id == manifest.export_id


@pytest.mark.asyncio
async def test_archive_builder_rejects_noncanonical_or_traversal_paths(portability_key) -> None:
    async def empty_writer(stream):
        stream.write(b"")
        return 0

    with pytest.raises(ValueError, match="非法目录段"):
        await build_encrypted_archive(
            io.BytesIO(),
            context="owner/export-fixture",
            origin_id=uuid4(),
            export_id=uuid4(),
            producers=[ArchiveProducer("../escape.jsonl", "projects", empty_writer)],
            complete=False,
        )


@pytest.mark.asyncio
async def test_archive_validation_accepts_memory_indexes_and_validates_single_json_records(portability_key) -> None:
    records = {
        "records/account.json": (
            b'{"record_schema":"gugu.account.v1","portable_id":"account-profile-v1",'
            b'"source_type":"account","fields":{"username":"sample"},"relations":[]}\n'
        ),
        "memory/im/scopes.jsonl": (
            b'{"platform":"qq","bot_id":"bot-a","scope_type":"group",'
            b'"scope_id":"group-a","deleted":false}\n'
        ),
        "memory/im/deletion_markers.jsonl": (
            b'{"platform":"qq","bot_id":"bot-a","scope_type":"platform-user",'
            b'"scope_id":"user-a","deleted":true}\n'
        ),
    }

    producers = []
    for path, content in records.items():
        async def write(stream, payload=content):
            stream.write(payload)
            return len(payload.splitlines())
        category = "account" if path.startswith("records/") else "im_memory"
        producers.append(ArchiveProducer(path, category, write))

    encrypted = io.BytesIO()
    await build_encrypted_archive(
        encrypted, context="owner/export-fixture", origin_id=uuid4(), export_id=uuid4(),
        producers=producers, complete=False, included_categories={"account", "im_memory"},
    )
    encrypted.seek(0)
    result = validate_encrypted_archive(encrypted, context="owner/export-fixture")
    assert result.record_count == 3
    assert result.categories["account"] == 1


@pytest.mark.asyncio
async def test_archive_validation_rejects_record_category_mismatch(portability_key) -> None:
    payload = (
        b'{"record_schema":"gugu.project.v1","portable_id":"p-1",'
        b'"source_type":"project","fields":{"name":"demo"},"relations":[]}\n'
    )

    async def write(stream):
        stream.write(payload)
        return 1

    encrypted = io.BytesIO()
    await build_encrypted_archive(
        encrypted, context="owner/export-fixture", origin_id=uuid4(), export_id=uuid4(),
        producers=[ArchiveProducer("records/projects.jsonl", "clients", write)],
        complete=False, included_categories={"clients"},
    )
    encrypted.seek(0)
    with pytest.raises(ValueError, match="类型与类别不匹配"):
        validate_encrypted_archive(encrypted, context="owner/export-fixture")
