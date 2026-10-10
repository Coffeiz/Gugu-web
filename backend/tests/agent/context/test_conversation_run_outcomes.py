"""Run 展示终态与模型可见对话正文分离。"""
from __future__ import annotations

import pytest

from app.models import ConversationMessage, ConversationSession
from app.services.conversation_run_outcomes import (
    RunOutcomeTarget,
    build_run_outcome,
    persist_run_outcome,
)
from agent.context.session_history import load_session_history
import app.db.session as _sess


@pytest.mark.asyncio
async def test_failed_outcome_persists_without_becoming_canonical_message(db, user_a):
    session = ConversationSession(user_id=user_a.id, title="run outcome test")
    db.add(session)
    await db.flush()
    user_message = ConversationMessage(
        session_id=session.id,
        role="user",
        content="请执行任务",
    )
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)

    outcome = build_run_outcome(
        status="failed",
        run_id="run-safe-id",
        error_code="provider_unavailable",
        message_key="chatUi.providerUnavailable",
        message_params={
            "tag": "500",
            "attempts": 2,
            "diagnostic_id": "A1B2C3D4",
            "minimax_request_id": "provider-request-123",
            "raw_exception": "must-not-be-stored",
            "api_key": "must-not-be-stored",
        },
    )
    persisted = await persist_run_outcome(
        _sess._SessionLocal,
        RunOutcomeTarget(user_a.id, session.id, user_message.id, "run-safe-id"),
        outcome,
    )

    assert persisted
    await db.refresh(user_message)
    assert user_message.content == "请执行任务"
    assert user_message.run_outcome["status"] == "failed"
    assert user_message.run_outcome["messageParams"] == {
        "tag": "500", "attempts": 2, "diagnostic_id": "A1B2C3D4",
        "minimax_request_id": "provider-request-123",
    }
    assert "api_key" not in user_message.run_outcome["messageParams"]
    assert "raw_exception" not in user_message.run_outcome["messageParams"]
    history = await load_session_history(db, session.id)
    assert [(message.role, message.content) for message in history] == [
        ("user", "请执行任务"),
    ]


@pytest.mark.asyncio
async def test_interruption_has_distinct_persisted_status(db, user_a):
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.flush()
    user_message = ConversationMessage(session_id=session.id, role="user", content="继续")
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)

    outcome = build_run_outcome(status="interrupted", run_id="run-interrupted")
    assert outcome["status"] == "interrupted"
    assert outcome["errorCode"] == "cancelled"
    assert await persist_run_outcome(
        _sess._SessionLocal,
        RunOutcomeTarget(user_a.id, session.id, user_message.id, "run-interrupted"),
        outcome,
    )
    await db.refresh(user_message)
    assert user_message.run_outcome == outcome
