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


@pytest.mark.parametrize("context_tokens", [4_096, 8_192])
@pytest.mark.parametrize("outcome", ["split_success", "single_reduced_success", "single_too_large", "provider_unavailable"])
async def test_im_memory_preview_retries_only_provider_overflow(
    monkeypatch, context_tokens, outcome,
):
    """小窗口中文请求被拒后拆批，保留原消息；任何子批失败时不生成可执行计划。"""
    from contextlib import asynccontextmanager
    import json
    from types import SimpleNamespace

    from agent.context import provider_runner
    from agent.memory import im_reflection
    from app.core.redis import get_redis

    @asynccontextmanager
    async def empty_session():
        yield None

    async def db_session():
        return empty_session()

    rows = [
        SimpleNamespace(id=1, created_at=None, text="合成消息甲" * 65),
        SimpleNamespace(id=2, created_at=None, text="合成消息乙" * 65),
    ]

    async def messages(*_args):
        return rows

    async def read_scope(*_args):
        return {"summary": "合成旧记忆" * 3000}

    monkeypatch.setattr(im_reflection, "_db_session", db_session)
    monkeypatch.setattr(im_reflection, "_messages_for_job", messages)
    monkeypatch.setattr(im_reflection, "_message_text", lambda row: row.text)
    monkeypatch.setattr(im_reflection, "_scope_prompt", lambda *_args, **_kwargs: "合成整理提示")
    monkeypatch.setattr("agent.memory.scoped_store.read_scope", read_scope)

    attempts = []

    async def run(_system, prompt, _settings, *, max_tokens, thinking):
        memory, payload = prompt.split("\n\n本批新增消息：\n", 1)
        attempts.append((memory, payload, max_tokens))
        contains_first = rows[0].text in payload
        contains_second = rows[1].text in payload
        if outcome == "provider_unavailable":
            raise RuntimeError("合成上游服务不可用")
        still_too_large = contains_second and (
            outcome == "single_too_large"
            or (outcome == "single_reduced_success" and "合成旧记忆" in memory)
        )
        if (contains_first and contains_second) or still_too_large:
            raise ValueError("maximum context length exceeded")
        output = {"facts": ["甲" if contains_first else "乙"]}
        if "合成旧记忆" not in memory:
            output.update(summary="不可覆盖旧摘要", profile_remove=["不可删除旧资料"])
        return output

    monkeypatch.setattr(provider_runner, "complete_json", run)
    await agent_admin._im_model_preview_worker(
        [{
            "owner_user_id": "00000000-0000-0000-0000-000000000001",
            "platform": "qq", "bot_id": "合成", "scope_type": "group", "scope_id": "测试群",
            "first_message_id": 1, "last_message_id": 2,
        }],
        SimpleNamespace(ai=SimpleNamespace(context_tokens=context_tokens, max_tokens=8000)),
    )
    redis = get_redis()
    state = json.loads(await redis.get(agent_admin._IM_MODEL_PREVIEW_KEY))
    plans = json.loads(await redis.get(agent_admin._IM_MODEL_PREVIEW_PLAN_KEY))
    assert state["status"] == "done"
    assert len(attempts[0][0].split("\n", 1)[1]) <= {4096: 400, 8192: 1000}[context_tokens]
    assert attempts[0][2] == context_tokens // 4
    assert [sum(row.text in payload for row in rows) for _, payload, _ in attempts] == {
        "split_success": [2, 1, 1],
        "single_too_large": [2, 1, 1, 1],
        "single_reduced_success": [2, 1, 1, 1],
        "provider_unavailable": [2],
    }[outcome]
    if outcome in {"split_success", "single_reduced_success"}:
        assert state["plan_ready"] is True
        assert state["total_batches"] == state["completed_batches"] == 2
        assert plans[0]["source_message_ids"] == ["1", "2"]
        assert plans[0]["output"] == {"facts": ["甲", "乙"]}
    else:
        assert plans == []
        assert state["failed"] == 1
        assert state["plan_ready"] is False
        if outcome == "single_too_large":
            assert attempts[-1][1] == attempts[-2][1]
            assert "合成旧记忆" not in attempts[-1][0]
