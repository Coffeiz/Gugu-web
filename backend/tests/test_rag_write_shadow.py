"""RAG 写路径影子比对：TS adapt 投影 vs Python 写库产物的 chunk 级对账。"""
import dataclasses
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.rag.index_builder import calendar_record, file_record
from agent.rag.models import Scope
from agent.rag.write_shadow import scope_to_wire, shadow_compare_build

OWNER = "write-shadow-owner"
OWNER_SCOPE = Scope(OWNER)


def _shadow_settings(*, enabled: bool = True, command: str = "") -> SimpleNamespace:
    return SimpleNamespace(search=SimpleNamespace(
        rag_write_shadow=enabled, ts_sidecar_command=command,
    ))


def _worker_command() -> str:
    worker = Path(__file__).parents[1] / "ts" / "workers" / "rag" / "src" / "index.ts"
    return f"node --experimental-strip-types {worker}"


@pytest.mark.asyncio
async def test_scope_to_wire_empty_values_become_blank():
    scope = scope_to_wire(Scope("u"))
    assert scope == {"scope_type": "owner", "scope_id": "",
                     "platform": "", "bot_id": "", "group_id": ""}


@pytest.mark.asyncio
async def test_shadow_disabled_or_recordless_is_skipped():
    record = file_record(SimpleNamespace(
        id=1, display_name="方案.md", ext="md", mime_type=None, project_id=None,
        folder_id=None, space="", stage_name="", version="v1", updated_at=None,
    ), "正文")
    # 关闭开关：直接跳过，不触碰 worker。
    assert await shadow_compare_build(
        OWNER, "file", [(record, OWNER_SCOPE)], [],
        settings=_shadow_settings(enabled=False)) is None
    # 无 record 管线的来源（memory/knowledge/project）：跳过。
    assert await shadow_compare_build(
        OWNER, "memory", None, [], settings=_shadow_settings(enabled=True)) is None


@pytest.mark.asyncio
async def test_shadow_equal_with_real_worker(tmp_path):
    rows = [
        (SimpleNamespace(
            id=7, display_name="方案.md", ext="md", mime_type="text/markdown",
            project_id=3, folder_id=9, space="项目A", stage_name="评审",
            version="v3", updated_at=None,
        ), "这是文件正文"),
        (SimpleNamespace(
            id=9, display_name="长文.txt", ext="txt", mime_type="text/plain",
            project_id=None, folder_id=None, space="", stage_name="",
            version="v1", updated_at=None,
        ), "字" * 3000),
    ]
    records = [(file_record(row, body), OWNER_SCOPE) for row, body in rows]
    from agent.rag.index_builder import documents_from_records

    documents = documents_from_records(OWNER, records)
    diagnostic = await shadow_compare_build(
        OWNER, "file", records, documents,
        settings=_shadow_settings(command=_worker_command()))
    assert diagnostic["equal"] is True
    assert diagnostic["python_chunks"] == len(documents)
    assert diagnostic["ts_chunks"] == len(documents)
    assert "first_diff_index" not in diagnostic
    assert diagnostic["elapsed_ms"] >= 0


@pytest.mark.asyncio
async def test_shadow_detects_written_document_drift(tmp_path):
    record = calendar_record(SimpleNamespace(
        id=9, title="发布会", date="2026-09-10", time="14:00", description="线上直播",
        project_id=3, version="v1",
    ))
    records = [(record, OWNER_SCOPE)]
    from agent.rag.index_builder import documents_from_records

    documents = documents_from_records(OWNER, records)
    # 模拟写库产物被改写一个字段：影子必须抓到 chunk 级漂移。
    drifted = [dataclasses.replace(document, summary="被篡改的摘要") for document in documents]
    diagnostic = await shadow_compare_build(
        OWNER, "calendar", records, drifted,
        settings=_shadow_settings(command=_worker_command()))
    assert diagnostic["equal"] is False
    assert diagnostic["first_diff_index"] == 0
    assert "summary" in diagnostic["diff_fields"]


@pytest.mark.asyncio
async def test_shadow_worker_failure_is_isolated():
    record = file_record(SimpleNamespace(
        id=1, display_name="方案.md", ext="md", mime_type=None, project_id=None,
        folder_id=None, space="", stage_name="", version=None, updated_at=None,
    ), "正文")
    from agent.rag.index_builder import documents_from_records

    records = [(record, OWNER_SCOPE)]
    documents = documents_from_records(OWNER, records)
    # 不可用的 worker 命令：诊断记 error，绝不向写路径抛出。
    diagnostic = await shadow_compare_build(
        f"{OWNER}-failure", "file", records, documents,
        settings=_shadow_settings(command="nonexistent-worker-binary-xyz"))
    assert diagnostic["equal"] is None
    assert diagnostic["error"]


@pytest.mark.asyncio
async def test_rebuild_knowledge_index_runs_shadow(tmp_path, db, user_a, monkeypatch):
    import app.core.config as config_module
    from app.models import CalendarEvent
    from agent.rag.index_builder import rebuild_knowledge_index

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()

    captured: dict[str, object] = {}

    async def _capture(owner_user_id, source_type, records, documents):
        captured["source_type"] = source_type
        captured["records"] = records
        captured["documents"] = documents
        return await shadow_compare_build(
            owner_user_id, source_type, records, documents,
            settings=_shadow_settings(command=_worker_command()))

    monkeypatch.setattr(
        "agent.rag.write_shadow.shadow_compare_build", _capture)
    counts = await rebuild_knowledge_index(db, user_a.id, ["calendar"])
    assert counts["calendar"] >= 1
    assert captured["source_type"] == "calendar"
    assert captured["records"]
