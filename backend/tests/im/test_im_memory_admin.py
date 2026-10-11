"""IM 记忆管理接口只暴露汇总，并要求批量整理显式确认。"""

import pytest
from fastapi import HTTPException

from app.api.v1 import agent_admin


async def test_im_memory_summary_does_not_expose_scope_identifiers(monkeypatch):
    async def fake_list_scopes(*, limit):
        assert limit == 10000
        return [
            {
                "owner_user_id": "owner-secret",
                "platform": "qq",
                "bot_id": "bot-secret",
                "scope_type": "group",
                "scope_id": "group-secret",
                "entry_count": 3,
                "last_message_id": 12,
                "last_reflected_message_id": 8,
                "pending_jobs": 2,
                "failed_jobs": 1,
            },
            {
                "owner_user_id": "member-secret",
                "platform": "qq",
                "bot_id": "bot-secret",
                "scope_type": "platform-user",
                "scope_id": "member-secret",
                "entry_count": 1,
                "last_message_id": 4,
                "last_reflected_message_id": 4,
                "pending_jobs": 0,
                "failed_jobs": 0,
            },
        ]

    monkeypatch.setattr("agent.memory.scope_lifecycle.list_scopes", fake_list_scopes)
    result = await agent_admin.list_im_memory_scopes()

    assert result["total_scopes"] == 2
    assert result["groups"] == 1
    assert result["members"] == 1
    assert result["total_entries"] == 4
    assert result["pending_jobs"] == 2
    assert result["needs_maintenance"] == 1
    assert result["failed_jobs"] == 1
    assert "owner_user_id" not in result
    assert "bot_id" not in result
    assert "scope_id" not in result
    assert "group-secret" not in str(result)
    assert "member-secret" not in str(result)


async def test_im_memory_maintenance_requires_confirmation():
    with pytest.raises(HTTPException) as exc_info:
        await agent_admin.apply_im_memory_maintenance(agent_admin.ImMemoryMaintenanceRequest(confirm=False))

    assert exc_info.value.status_code == 400
