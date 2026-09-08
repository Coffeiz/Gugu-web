"""写路径移交第③步：``rag_write_mode`` 三态开关与 TS 投影落库通道。"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent.rag.index_builder import (
    build_source_records,
    documents_from_records,
    rebuild_knowledge_index,
    records_to_write_documents,
)
from agent.rag.models import Scope
from agent.rag.ts_sidecar import _wire_document, wire_document_to_persistent
from agent.rag.write_shadow import shadow_compare_build
from app.models import CalendarEvent, KnowledgeIndexEntry

OWNER = "write-mode-owner"


@pytest.mark.asyncio
async def test_python_mode_matches_local_projection(db, user_a):
    from app.core.config import get_settings

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()
    records = await build_source_records(db, user_a.id, "calendar")
    documents = await records_to_write_documents(user_a.id, "calendar", records)
    assert documents == documents_from_records(user_a.id, records)
    assert get_settings().search.rag_write_mode == "python"


@pytest.mark.asyncio
async def test_wire_document_to_persistent_round_trip():
    record = SimpleNamespace(
        id=7, display_name="方案.md", ext="md", mime_type="text/markdown",
        project_id=3, folder_id=9, space="项目A", stage_name="评审",
        version="v3", updated_at=None,
    )
    document = documents_from_records(OWNER, [(
        {"source_type": "file", "id": "7", "title": "方案.md", "ext": "md",
         "mime_type": "text/markdown", "project_id": "3", "folder_id": "9",
         "space": "项目A", "stage_name": "评审", "content": "正文",
         "version_parts": ["7", "v3"], "updated_at": None},
        Scope(OWNER),
    )])[0]
    wire = _wire_document(document)
    recovered = wire_document_to_persistent(wire, OWNER)
    assert recovered.document_id == "file:7"
    assert recovered.chunk_index == document.chunk_index
    assert _wire_document(recovered) == wire


def test_wire_document_to_persistent_rejects_malformed():
    from agent.rag.ts_sidecar import TsSidecarUnavailable  # noqa: F401  确认模块可达

    with pytest.raises(ValueError):
        wire_document_to_persistent({"id": "file:file:7:0", "content": "正文"}, OWNER)
    with pytest.raises(ValueError):
        wire_document_to_persistent({"id": "file:file:7:0", "parent_id": "file:7"}, OWNER)


@pytest.mark.asyncio
async def test_ts_mode_failure_propagates_without_silent_fallback(db, user_a, monkeypatch):
    from app.core.config import get_settings

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()
    monkeypatch.setattr(get_settings().search, "rag_write_mode", "ts")

    async def _broken(self, source_type, records):
        raise RuntimeError("worker 炸了")

    monkeypatch.setattr(
        "agent.rag.ts_sidecar.TsSidecarClient.adapt_records", _broken)
    records = await build_source_records(db, user_a.id, "calendar")
    with pytest.raises(RuntimeError):
        await records_to_write_documents(user_a.id, "calendar", records)
    rows = (await db.execute(
        select(KnowledgeIndexEntry).where(KnowledgeIndexEntry.owner_user_id == user_a.id)
    )).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_ts_and_python_modes_write_identical_rows(db, user_a, monkeypatch):
    from app.core.config import get_settings

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    db.add(CalendarEvent(user_id=user_a.id, title="全天事件", date="2026-09-11",
                         time="", description=""))
    await db.commit()

    def _row_tuples(rows):
        return sorted(
            (row.document_id, row.source_id, row.document_version, row.chunk_index,
             row.chunk_count, row.title, row.summary, row.content, row.content_hash,
             row.scope_type, row.scope_id, row.metadata_json and sorted(row.metadata_json.items()),
             row.source_updated_at.isoformat() if row.source_updated_at else None)
            for row in rows
        )

    await rebuild_knowledge_index(db, user_a.id, ["calendar"])
    python_rows = _row_tuples((await db.execute(
        select(KnowledgeIndexEntry).where(KnowledgeIndexEntry.owner_user_id == user_a.id)
    )).scalars().all())
    assert python_rows

    monkeypatch.setattr(get_settings().search, "rag_write_mode", "ts")
    await rebuild_knowledge_index(db, user_a.id, ["calendar"])
    ts_rows = _row_tuples((await db.execute(
        select(KnowledgeIndexEntry).where(KnowledgeIndexEntry.owner_user_id == user_a.id)
    )).scalars().all())
    assert ts_rows == python_rows


@pytest.mark.asyncio
async def test_ts_mode_shadow_guards_python_dialect_drift(db, user_a, monkeypatch):
    from app.core.config import get_settings

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()
    settings = get_settings()
    monkeypatch.setattr(settings.search, "rag_write_mode", "ts")
    monkeypatch.setattr(settings.search, "rag_write_shadow", True)

    captured: dict[str, dict] = {}

    real_adapt = None
    from agent.rag.ts_sidecar import TsSidecarClient

    real_adapt = TsSidecarClient.adapt_records

    async def _drifted(self, source_type, records):
        documents = await real_adapt(self, source_type, records)
        for raw in documents:
            raw["content"] = raw["content"] + "漂移尾巴"
            raw["summary"] = raw["summary"] + "漂移尾巴"
        return documents

    monkeypatch.setattr(TsSidecarClient, "adapt_records", _drifted)

    real_shadow = shadow_compare_build

    async def _capture(owner_user_id, source_type, records, documents, *, settings=None):
        diagnostic = await real_shadow(owner_user_id, source_type, records, documents,
                                       settings=settings)
        captured["diagnostic"] = diagnostic
        return diagnostic

    monkeypatch.setattr("agent.rag.write_shadow.shadow_compare_build", _capture)
    counts = await rebuild_knowledge_index(db, user_a.id, ["calendar"])
    assert counts["calendar"] >= 1
    diagnostic = captured["diagnostic"]
    # ts 模式下影子基线是 Python 本地投影：adapt 漂移必须被抓到。
    assert diagnostic["equal"] is False
    assert diagnostic["write_mode"] == "ts"
    assert "content" in diagnostic["diff_fields"]
    # 已写库的 TS 产物确实带着漂移（不回退、不静默纠正）。
    rows = (await db.execute(
        select(KnowledgeIndexEntry).where(KnowledgeIndexEntry.owner_user_id == user_a.id)
    )).scalars().all()
    assert any("漂移尾巴" in (row.content or "") for row in rows)
