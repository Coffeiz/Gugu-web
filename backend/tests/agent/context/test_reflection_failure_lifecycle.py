"""反思生命周期：审核拒绝不重打、删除会话不留下永久重试缓冲。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import json

import anthropic
import httpx
import pytest

from agent.context.branch import ContextBranch
from agent.context.branch_types import BranchInput, BranchPolicy
from agent.memory import im_reflection, reflection, reflection_idle
from agent.providers.errors import ProviderInputRejected, is_provider_input_rejected
from app.core.redis import get_redis
from app.models import ConversationSession, MemoryReflectionJob
from app.services.conversation_cleanup import remove_session_with_attachments


def _provider_error(message):
    response = httpx.Response(500, request=httpx.Request("POST", "https://example.invalid/messages"))
    return anthropic.InternalServerError(
        "上游响应仅进入受限诊断", response=response,
        body={"type": "error", "error": {"type": "api_error", "message": message}},
    )


@pytest.mark.parametrize("message, expected", [
    ("input new_sensitive (1026)", True),
    ("server overloaded", False),
    ("用户正文提到了 input new_sensitive (1026)", False),
])
def test_rejection_requires_exact_structured_upstream_error(message, expected):
    """普通服务故障和正文里的相似字符串不能变成不可重试错误。"""
    wrapped = RuntimeError("包装异常")
    wrapped.__cause__ = _provider_error(message)
    assert is_provider_input_rejected(wrapped) is expected
    assert not is_provider_input_rejected(RuntimeError(message))


async def test_branch_stops_rejected_input_even_with_retry_budget(monkeypatch, caplog):
    runner = AsyncMock(side_effect=_provider_error("input new_sensitive (1026)"))
    monkeypatch.setattr("agent.context.branch.diag_log", lambda *args: None)
    result = await ContextBranch().run(
        BranchInput(stable_system="合成提示词"),
        BranchPolicy(name="reflection", max_retries=4), SimpleNamespace(), runner=runner,
    )
    assert not result.ok
    assert result.return_reason == "provider_error"
    assert result.provider_error_code == "input_sensitive"
    assert result.attempts == runner.await_count == 1
    assert "上游响应仅进入受限诊断" not in caplog.text


@pytest.mark.parametrize("rejected", [True, False])
async def test_job_persists_rejection_terminal_but_retries_transient_failure(db, user_a, rejected):
    job = MemoryReflectionJob(
        owner_user_id=user_a.id, platform="qq", bot_id="示例机器人",
        scope_type="group", scope_id="示例群", idempotency_key="synthetic-job",
        status="running", retry_count=0,
    )
    db.add(job)
    await db.commit()
    error = ProviderInputRejected() if rejected else _provider_error("server overloaded")
    await im_reflection._mark_failure(db, job, error)
    await db.refresh(job)
    assert job.retry_count == 1
    assert job.status == ("dead" if rejected else "retry")
    assert job.last_error_code == ("input_sensitive" if rejected else "InternalServerError")
    assert (job.next_attempt_at is None) is rejected
    assert (job.dead_at is not None) is rejected


async def test_im_rejection_propagates_from_provider_to_persisted_dead_job(db, user_a, monkeypatch):
    """经过真实分支和任务执行器：拒绝只调用一次，终态重投不再请求模型。"""
    from agent.context import provider_runner

    job = MemoryReflectionJob(
        owner_user_id=user_a.id, platform="qq", bot_id="示例机器人",
        scope_type="platform-user", scope_id="示例成员", task_type="private-owner",
        idempotency_key="synthetic-rejected-job", status="pending", retry_count=0,
    )
    db.add(job)
    await db.commit()
    model = SimpleNamespace()
    monkeypatch.setattr("agent.llm.llm_select.resolve_run_config_for_user", AsyncMock(
        return_value=SimpleNamespace(model=model)))
    monkeypatch.setattr("app.byok.service.resolve_and_bind_user_embedding", AsyncMock())
    monkeypatch.setattr(im_reflection, "_messages_for_job", AsyncMock(
        return_value=[SimpleNamespace(session_id=12345, content="合成消息")]))
    monkeypatch.setattr(im_reflection, "_rebuild_session_snapshot", AsyncMock(return_value=SimpleNamespace()))
    monkeypatch.setattr("agent.context.compress_conv.compact_for_reflection", AsyncMock(return_value="skipped"))
    monkeypatch.setattr(im_reflection, "read_scope", AsyncMock(return_value={}))
    monkeypatch.setattr(im_reflection, "_build_append_branch_input",
                        lambda *a, **k: BranchInput(stable_system="合成提示词"))
    monkeypatch.setattr("agent.context.branch.diag_log", lambda *a: None)
    monkeypatch.setattr("app.core.redaction.diag_log", lambda *a: None)
    provider = AsyncMock(side_effect=_provider_error("input new_sensitive (1026)"))
    monkeypatch.setattr(provider_runner, "complete_json", provider)
    for _ in range(2):
        assert not await im_reflection._execute_job_locked(job.id, SimpleNamespace())
    await db.refresh(job)
    assert job.status == "dead"
    assert job.last_error_code == "input_sensitive"
    assert job.retry_count == provider.await_count == 1
    assert job.next_attempt_at is None


async def _seed_buffer(user_id, sid, *, group_mode=False):
    redis = get_redis()
    key = (reflection._owner_group_buffer_key if group_mode
           else reflection._owner_reflection_buffer_key)(user_id, sid)
    idle = (reflection_idle.GROUP_OWNER_IDLE_KEY if group_mode
            else reflection_idle.OWNER_IDLE_KEY)
    member = reflection._owner_idle_member(user_id, sid)
    await redis.rpush(key, json.dumps({"session_id": sid, "user_msg": "合成内容"}, ensure_ascii=False))
    await redis.zadd(idle, {member: 1})
    return key, idle, member


@pytest.mark.parametrize("group_mode", [False, True])
async def test_orphan_consumer_discards_only_missing_owned_session(db, user_a, user_b, monkeypatch, group_mode):
    """即使旧生产队列未清理，重复扫描也不调用模型、不回队、不触及别的用户。"""
    redis = get_redis()
    lock = SimpleNamespace(acquire=AsyncMock(return_value=True), release=AsyncMock())
    monkeypatch.setattr(redis, "lock", lambda *a, **k: lock)
    run = AsyncMock()
    monkeypatch.setattr(reflection, "_reflect_buffer_rows", run)
    orphan = await _seed_buffer(user_a.id, 987654, group_mode=group_mode)
    other = await _seed_buffer(user_b.id, 987654, group_mode=group_mode)
    for _ in range(2):
        await reflection._drain_reflection_buffer(
            user_a.id, SimpleNamespace(), session_id=987654,
            group_mode=group_mode, allow_rebuild=True,
        )
    assert await redis.llen(orphan[0]) == 0
    assert await redis.zscore(orphan[1], orphan[2]) is None
    assert await redis.llen(other[0]) == 1
    assert await redis.zscore(other[1], other[2]) == 1
    run.assert_not_awaited()
    assert lock.release.await_count == 2


async def test_existing_busy_owned_session_is_not_classified_as_deleted(db, user_a, user_b):
    session = ConversationSession(user_id=user_a.id, execution_state="running", pending_message_count=1)
    db.add(session)
    await db.commit()
    assert await reflection._reflection_session_exists(user_a.id, session.id)
    assert not await reflection._reflection_session_exists(user_b.id, session.id)


@pytest.mark.parametrize("database_unavailable", [False, True])
async def test_transient_drain_failure_restores_exactly_one_copy(db, user_a, monkeypatch, database_unavailable):
    """查库失败和模型暂时失败都保留原内容，不丢失也不重复回填。"""
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.commit()
    redis = get_redis()
    lock = SimpleNamespace(acquire=AsyncMock(return_value=True), release=AsyncMock())
    monkeypatch.setattr(redis, "lock", lambda *a, **k: lock)
    key, idle, member = await _seed_buffer(user_a.id, session.id)
    before = await redis.lrange(key, 0, -1)
    if database_unavailable:
        monkeypatch.setattr(reflection, "_reflection_session_exists", AsyncMock(side_effect=RuntimeError("合成查库失败")))
    monkeypatch.setattr(reflection, "_reflect_buffer_rows", AsyncMock(side_effect=RuntimeError("合成暂时失败")))
    monkeypatch.setattr("app.core.redaction.diag_log", lambda *a: None)
    await reflection._drain_reflection_buffer(
        user_a.id, SimpleNamespace(), session_id=session.id, group_mode=False, allow_rebuild=True,
    )
    assert await redis.lrange(key, 0, -1) == before
    assert await redis.zscore(idle, member) > 1
    lock.release.assert_awaited_once()


async def test_delete_session_cleans_both_buffers_and_preserves_other_session(db, user_a):
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.commit()
    buffers = [await _seed_buffer(user_a.id, session.id, group_mode=mode) for mode in (False, True)]
    other = await _seed_buffer(user_a.id, session.id + 1)
    await remove_session_with_attachments(db, session)
    redis = get_redis()
    for key, idle, member in buffers:
        assert await redis.llen(key) == 0
        assert await redis.zscore(idle, member) is None
    assert await redis.llen(other[0]) == 1
    assert not await reflection._reflection_session_exists(user_a.id, session.id)


async def test_failed_database_delete_keeps_reflection_buffer(db, user_a, monkeypatch):
    session = ConversationSession(user_id=user_a.id)
    db.add(session)
    await db.commit()
    key, idle, member = await _seed_buffer(user_a.id, session.id)
    monkeypatch.setattr(db, "commit", AsyncMock(side_effect=RuntimeError("合成事务失败")))
    with pytest.raises(RuntimeError, match="合成事务失败"):
        await remove_session_with_attachments(db, session)
    redis = get_redis()
    assert await redis.llen(key) == 1
    assert await redis.zscore(idle, member) == 1
