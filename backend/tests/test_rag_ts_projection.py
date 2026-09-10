"""TS canonical source projection 的 Python 边界回归。"""
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.rag.index_builder import (
    build_source_documents,
    calendar_record,
    conversation_message_record,
    records_to_write_documents,
)
from agent.rag.models import Scope
from agent.rag.ts_sidecar import TsSidecarClient

OWNER = "ts-projection-owner"
SCOPE = Scope(OWNER)


def _worker_command() -> str:
    worker = Path(__file__).parents[1] / "ts" / "workers" / "rag" / "src" / "index.ts"
    return f"node --experimental-strip-types {worker}"


def _dt(year: int, month: int, day: int, hour: int = 0, minute: int = 0):
    import datetime

    return datetime.datetime(year, month, day, hour, minute)


@pytest.mark.asyncio
async def test_ts_projection_keeps_full_context_for_every_conversation_chunk(tmp_path):
    class _Session:
        id = 2
        title = "长消息会话"
        source = "web"
        summary = ""
        updated_at = _dt(2026, 9, 9, 1)

    class _Message:
        id = 20
        role = "user"
        content = "部署上下文" * 400
        created_at = _dt(2026, 9, 9, 0, 30)
        sent_at = _dt(2026, 9, 9, 0, 31)

    record = conversation_message_record(
        _Session(), _Message(),
        context_before="assistant：上一条结论",
        context_after="assistant：下一条建议",
    )
    documents = await records_to_write_documents(
        OWNER, "conversation", [(record, SCOPE)],
        settings=SimpleNamespace(search=SimpleNamespace(ts_sidecar_command="")),
    )

    assert len(documents) > 1
    assert all(document.metadata["context_current"].count("部署上下文") == 400 for document in documents)
    assert all(document.contextual_content().count("部署上下文") == 400 for document in documents)


@pytest.mark.asyncio
async def test_build_source_documents_is_ts_canonical_wrapper(db, user_a):
    from app.models import CalendarEvent

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()

    documents = await build_source_documents(db, user_a.id, "calendar")

    assert len(documents) == 1
    assert documents[0].source_type == "calendar"
    assert documents[0].content.startswith("活动：发布会")


@pytest.mark.asyncio
async def test_ts_projection_failure_is_not_hidden(db, user_a, monkeypatch):
    from app.models import CalendarEvent

    db.add(CalendarEvent(user_id=user_a.id, title="发布会", date="2026-09-10",
                         time="14:00", description="线上直播"))
    await db.commit()
    record = calendar_record(SimpleNamespace(
        id=9, title="发布会", date="2026-09-10", time="14:00", description="线上直播",
        project_id=None, version="v1",
    ))

    async def _broken(self, source_type, records):
        raise RuntimeError("TS worker 不可用")

    monkeypatch.setattr(TsSidecarClient, "adapt_records", _broken)
    with pytest.raises(RuntimeError, match="TS worker"):
        await records_to_write_documents(
            user_a.id, "calendar", [(record, Scope(str(user_a.id)))],
        )
