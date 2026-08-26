import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


def test_scheduled_messages_keep_snapshot_context_before_tail():
    from agent.runner import _build_scheduled_messages

    messages = _build_scheduled_messages(
        "稳定系统", "## 项目\n- 小北的计划", "2026-08-21（星期五）10:00",
        "执行任务", {"stance": "温和"}, use_anthropic=False,
    )
    assert messages[0] == {"role": "system", "content": "稳定系统"}
    assert "小北的计划" in messages[1]["content"]
    assert messages[2]["role"] == "user"
    assert "默认相处姿态" in messages[2]["content"]
    assert messages[3] == {"role": "user", "content": "执行任务"}
    assert sum("小北的计划" in item["content"] for item in messages) == 1
    assert "当前时间" in messages[-1]["content"]


@pytest.mark.asyncio
async def test_scheduled_execution_always_uses_full_loop(monkeypatch, db, user_a):
    """创建任务不再调用 LLM 选择工具，执行阶段直接使用完整工具集。

    PRD-SCHEDULE-2：execution 最后一轮输出 report schema JSON，report 模块纯代码渲染。
    无工具时 execution 返回合法 schema，解析成功直接返回 summary。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=(
        '{"summary":"执行结果","context":"","status":"success"}',
        False, {"tool_names": [], "mutated": False},
    ))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, _status = await scheduled._run_agent(user_a.id, "测试任务", trial=True)

    assert result == "执行结果"
    execution.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_tools_run_schema_parse_without_reexecuting(monkeypatch, db, user_a):
    """PRD-SCHEDULE-2：有工具时 execution 返回 report schema，report 模块纯代码解析 summary。

    execution 只调一次（不再调 report LLM），summary 直接作为投递正文。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=(
        '{"summary":"整理后的报告","context":"调了 web_search","status":"success"}',
        False, {"tool_names": ["web_search"], "mutated": False},
    ))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, _status = await scheduled._run_agent(user_a.id, "查资料", trial=True)

    assert result == "整理后的报告"
    execution.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_execution_failure_after_mutation_is_not_replayed(monkeypatch, db, user_a):
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("写入后模型失败", True, {"tool_names": ["update_file"], "mutated": True}))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, _status = await scheduled._run_agent(user_a.id, "修改文件", trial=False)

    assert result == "写入后模型失败"
    execution.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_schema_parse_failure_retries_execution(monkeypatch, db, user_a):
    """PRD-SCHEDULE-2：execution 最后一轮不是合法 JSON → 重试一次 execution。

    第一次返回非 JSON 文本，第二次返回合法 schema。execution 应被调用 2 次，
    最终返回第二次的 summary。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(side_effect=[
        ("查询结果（不是 JSON）", False, {"tool_names": ["web_search"], "mutated": False}),
        ('{"summary":"整理后的报告","context":"","status":"success"}',
         False, {"tool_names": ["web_search"], "mutated": False}),
    ])
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, _status = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "整理后的报告"
    assert execution.await_count == 2


@pytest.mark.asyncio
async def test_scheduled_schema_parse_failure_mutated_never_reruns(monkeypatch, db, user_a):
    """P1：execution 成功但 schema 解析失败，且已产生写副作用（mutated=True）时，
    绝不重跑 execution——否则 create_project/update_file 等业务操作会被重复执行。

    此时直接 fallback 到 execution 原文，execution 只应被调用 1 次。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=(
        "不是 JSON",
        False,
        {"tool_names": ["create_project"], "mutated": True},
    ))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, status = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "不是 JSON"
    assert status == "success"
    assert execution.await_count == 1


@pytest.mark.asyncio
async def test_execute_task_marks_last_run_failed_on_exception(monkeypatch, db, user_a):
    """一次性任务执行抛异常：last_run_at 已经被写了，但不能就这么在"失败"状态里
    永远卡住——必须标 last_run_failed，且不能被当成"已经跑过"删掉或永久拒绝重试。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="会失败的任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(side_effect=RuntimeError("boom")))

    result = await scheduled.execute_task(task.id, is_trial=False)
    assert "错误" in result

    await db.refresh(task)
    assert task.last_run_failed is True
    assert task.last_run_at is not None   # 行还在，没被当成"已完成"删掉


@pytest.mark.asyncio
async def test_execute_task_allows_retry_after_previous_failure(monkeypatch, db, user_a):
    """失败过一次的一次性任务，必须还能再正式触发一次——不能被 last_run_at 永久挡住。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="重试任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(),
        last_run_failed=True,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value=("正文", [], "success")))
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"QQ": "已发送"}))

    result = await scheduled.execute_task(task.id, is_trial=False)

    assert result == {"QQ": "已发送"}
    # 成功后一次性任务会被删除，查不到就是删成功了。
    from sqlalchemy import select
    row = (await db.execute(select(ScheduledTask).where(ScheduledTask.id == task.id))).scalars().first()
    assert row is None


@pytest.mark.asyncio
async def test_execute_task_still_blocks_when_last_run_succeeded_state(db, user_a):
    """last_run_at 非空且没标失败（正在跑/刚成功）时，仍然要拒绝重复的正式触发。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="已在跑的任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(), last_run_failed=False,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    result = await scheduled.execute_task(task.id, is_trial=False)
    assert result == {"错误": "一次性任务已经执行过或正在执行"}


@pytest.mark.asyncio
async def test_once_task_in_flight_when_redis_lock_held(db, user_a, monkeypatch):
    """Redis 锁还在 = 真的正在跑，不能被列表清理/GC 当成"过期没跑"或"崩了"清掉。"""
    import app.scheduled_tasks as scheduled
    from app.core.tz import now_utc

    async def fake_exists(key):
        assert key == scheduled._scheduled_lock_key(999)
        return True

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    in_flight = await scheduled._once_task_is_in_flight(999, now_utc())
    assert in_flight is True


@pytest.mark.asyncio
async def test_once_task_not_in_flight_after_lock_expires_and_grace_passes(monkeypatch):
    """锁没了、last_run_at 也早就超过锁的 timeout：判定为不在跑（大概率是崩了），
    不再挡列表清理——调用方据此把它转成失败态，而不是当成"还在跑"一直悬着。"""
    import app.scheduled_tasks as scheduled
    from datetime import timedelta
    from app.core.tz import now_utc

    async def fake_exists(key):
        return False

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    long_ago = now_utc() - timedelta(seconds=scheduled._SCHEDULED_LOCK_TIMEOUT + 30)
    in_flight = await scheduled._once_task_is_in_flight(999, long_ago)
    assert in_flight is False


@pytest.mark.asyncio
async def test_once_task_in_flight_grace_window_after_lock_release(monkeypatch):
    """锁刚释放（执行刚结束），但还在锁 timeout 的宽限窗口内：不能立刻判定"不在跑"，
    避免执行结果还没来得及写 last_run_failed 的这一瞬间被误判成崩溃。"""
    import app.scheduled_tasks as scheduled
    from app.core.tz import now_utc

    async def fake_exists(key):
        return False

    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(exists=fake_exists))

    just_now = now_utc()
    in_flight = await scheduled._once_task_is_in_flight(999, just_now)
    assert in_flight is True


@pytest.mark.asyncio
async def test_run_now_uses_formal_execution_to_retry_failed_once_task(monkeypatch, db, user_a):
    """"立即运行"对已经失败过的一次性任务，必须走正式执行（is_trial=False），
    不然点了也不会清 last_run_failed、成功了也不会删任务——用户看起来毫无反应。"""
    import app.api.v1.scheduled_tasks as scheduled_api
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask
    from app.core.tz import now_utc

    task = ScheduledTask(
        user_id=user_a.id, name="失败过的一次性任务", payload="占位",
        cron="@once:2099-01-01T00:00:00", channels="qq", delivery_targets=None,
        last_run_at=now_utc(), last_run_failed=True,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    execute = AsyncMock(return_value={"QQ": "已发送"})
    monkeypatch.setattr(scheduled, "execute_task", execute)

    await scheduled_api.run_now(task.id, user_a, db)

    execute.assert_awaited_once_with(task.id, is_trial=False)


@pytest.mark.asyncio
async def test_run_now_uses_trial_for_normal_task(monkeypatch, db, user_a):
    """普通任务（没失败过/还没跑过）"立即运行"仍然是试运行，不写 last_run_at、
    不会因为这次点击就让任务被标记完成或删除。"""
    import app.api.v1.scheduled_tasks as scheduled_api
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="普通任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    execute = AsyncMock(return_value={"网页通知": "已发送"})
    monkeypatch.setattr(scheduled, "execute_task", execute)

    await scheduled_api.run_now(task.id, user_a, db)

    execute.assert_awaited_once_with(task.id, is_trial=True)


@pytest.mark.asyncio
async def test_scheduled_schema_parse_failure_twice_falls_back_to_execution_text(monkeypatch, db, user_a):
    """PRD-SCHEDULE-2：execution 重试后仍解析失败 → fallback 到 execution 原文。

    防止把空 schema 的兜底内容发出去——execution_text 是真实产出，比 `schema.get('summary')` 兜底更可靠。"""
    import app.scheduled_tasks as scheduled

    execution = AsyncMock(return_value=("查询结果", False, {"tool_names": ["web_search"], "mutated": False}))
    monkeypatch.setattr("agent.runner.run_scheduled_execution", execution)

    result, _files, _status = await scheduled._run_agent(user_a.id, "查天气", trial=False)

    assert result == "查询结果"
    assert execution.await_count == 2


@pytest.mark.asyncio
async def test_execute_task_renews_lock_for_long_running_task(monkeypatch, db, user_a):
    """任务执行时间超过一个续租周期：锁必须被 extend 续期，而不是放任它在任务还在跑
    的时候自然过期——否则 `_once_task_is_in_flight()` 会把仍在执行的任务误判成崩溃。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="慢任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    fake_lock = SimpleNamespace(
        acquire=AsyncMock(return_value=True),
        release=AsyncMock(),
        extend=AsyncMock(),
    )
    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(lock=lambda *a, **kw: fake_lock))
    monkeypatch.setattr(scheduled, "_SCHEDULED_LOCK_RENEW_INTERVAL", 0.01)

    async def slow_run_agent(*a, **kw):
        await asyncio.sleep(0.05)   # 跨越多个续租周期
        return "正文", [], "success"

    monkeypatch.setattr(scheduled, "_run_agent", slow_run_agent)
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"网页通知": "已发送"}))

    result = await scheduled.execute_task(task.id, is_trial=True)

    assert result == {"网页通知": "已发送"}
    assert fake_lock.extend.await_count >= 1
    fake_lock.extend.assert_awaited_with(scheduled._SCHEDULED_LOCK_TIMEOUT, replace_ttl=True)
    fake_lock.release.assert_awaited_once()


@pytest.mark.asyncio
async def test_execute_task_stops_renewing_after_completion(monkeypatch, db, user_a):
    """任务结束后续租协程必须被取消——不能留着一个孤儿协程继续给已释放的锁 extend。"""
    import app.scheduled_tasks as scheduled
    from app.models import ScheduledTask

    task = ScheduledTask(
        user_id=user_a.id, name="快任务", payload="占位",
        cron="0 9 * * *", channels="web", delivery_targets=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    fake_lock = SimpleNamespace(
        acquire=AsyncMock(return_value=True),
        release=AsyncMock(),
        extend=AsyncMock(),
    )
    monkeypatch.setattr("app.core.redis.get_redis", lambda: SimpleNamespace(lock=lambda *a, **kw: fake_lock))
    monkeypatch.setattr(scheduled, "_SCHEDULED_LOCK_RENEW_INTERVAL", 10)
    monkeypatch.setattr(scheduled, "_run_agent", AsyncMock(return_value=("正文", [], "success")))
    monkeypatch.setattr(scheduled, "deliver_to_channels", AsyncMock(return_value={"网页通知": "已发送"}))

    await scheduled.execute_task(task.id, is_trial=True)
    await asyncio.sleep(0)   # 让被取消的续租任务有机会真正结束

    running = [t for t in asyncio.all_tasks() if t.get_coro().__qualname__ == "_renew_lock_periodically" and not t.done()]
    assert running == []
    fake_lock.extend.assert_not_awaited()


# ── PR #9 复审 P1-3 回归：自动标题 vs 手动改名竞态 ──────────────────────────

@pytest.mark.asyncio
async def test_auto_title_skipped_when_title_locked(monkeypatch, db, user_a):
    """P1-3：手动改名后 title_locked=True，_gen_title_bg 跳过——手动标题永远赢。

    复现：用户首轮消息触发 _schedule_title（异步启动 _gen_title_bg）→ 异步任务
    还没拿到 LLM 返回 → 用户手动 rename → 自动标题生成完成 → 若无 title_locked
    会无条件覆盖手动标题。
    """
    from app.models import ConversationSession
    from agent import runner

    sess = ConversationSession(
        user_id=user_a.id, title="临时标题", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    # mock LLM：返回会自动覆盖的标题
    async def fake_generate_title(user_msg, ai_reply, settings, use_anthropic):
        return "自动生成的标题"

    # 模拟"先生成标题，但 LLM 还在跑"：suspend 生成以确保 rename 先完成
    title_started = Mock()
    generated_title = "LLM_自动生成标题"
    async def slow_generate(user_msg, ai_reply, settings, use_anthropic):
        title_started()
        return generated_title
    monkeypatch.setattr("agent.gateway.web._generate_title", slow_generate)

    # 先模拟用户手动 rename（title_locked=True）
    sess.title = "用户手动改的标题"
    sess.title_locked = True
    await db.commit()

    # 然后 _gen_title_bg 跑
    from app.core.config import get_settings
    settings = get_settings()
    await runner._gen_title_bg(user_a.id, sess.id, "用户首轮", "咕咕首轮回复", settings, use_anthropic=False)

    # 验证：自动标题没覆盖手动标题
    await db.refresh(sess)
    assert sess.title == "用户手动改的标题", f"自动标题覆盖了手动标题：{sess.title!r}"
    assert sess.title_locked is True

    # 再跑一次也仍不覆盖（title_locked 永久生效）
    await runner._gen_title_bg(user_a.id, sess.id, "用户首轮", "咕咕首轮回复", settings, use_anthropic=False)
    await db.refresh(sess)
    assert sess.title == "用户手动改的标题"


@pytest.mark.asyncio
async def test_auto_title_never_overwrites_manual_rename_concurrent(monkeypatch, db, user_a):
    """P1-3 TOCTOU：并发跑 rename 与 _gen_title_bg，手动标题永远赢。

    旧实现是「先读 title_locked 再写 title」，存在窗口：auto 读到 False →
    rename 提交 → auto 覆盖。新实现用数据库原子条件 UPDATE
    （WHERE id=? AND title_locked=false），rename 无论哪个时序提交，auto 的
    UPDATE 都会因 title_locked=true 而 rowcount=0，绝不覆盖手动标题。

    这里用 asyncio.gather 并发触发 rename 与 auto title，验证最终 title 一定是
    用户改的（原子 UPDATE 保证，与执行顺序无关）。
    """
    import asyncio
    from app.models import ConversationSession
    from app.api.v1.agent import rename_session, RenameSessionRequest
    from agent import runner
    from app.core.config import get_settings

    sess = ConversationSession(
        user_id=user_a.id, title="临时标题", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    # mock LLM：返回会自动覆盖的标题
    async def slow_generate(user_msg, ai_reply, settings, use_anthropic):
        return "LLM_自动生成标题"
    monkeypatch.setattr("agent.gateway.web._generate_title", slow_generate)

    settings = get_settings()

    async def do_rename():
        await rename_session(sess.id, RenameSessionRequest(title="用户并发改名"), user_a, db)

    async def do_auto():
        await runner._gen_title_bg(user_a.id, sess.id, "用户首轮", "咕咕首轮回复", settings, use_anthropic=False)

    # 并发跑：无论谁先谁后，最终 title 都必须是用户改的
    await asyncio.gather(do_rename(), do_auto())

    await db.refresh(sess)
    assert sess.title == "用户并发改名", f"自动标题覆盖了手动标题：{sess.title!r}"
    assert sess.title_locked is True


@pytest.mark.asyncio
async def test_rename_session_api_sets_title_locked(monkeypatch, db, user_a):
    """P1-3：PATCH /sessions/{id} rename API 写 title_locked=True。"""
    from app.models import ConversationSession
    from app.api.v1.agent import rename_session
    from app.api.v1.agent import RenameSessionRequest

    sess = ConversationSession(
        user_id=user_a.id, title="旧标题", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    result = await rename_session(
        session_id=sess.id,
        body=RenameSessionRequest(title="用户改名"),
        current_user=user_a,
        db=db,
    )
    assert result["title"] == "用户改名"
    assert result["title_locked"] is True

    await db.refresh(sess)
    assert sess.title == "用户改名"
    assert sess.title_locked is True


@pytest.mark.asyncio
async def test_rename_session_rejects_empty_and_overlong(monkeypatch, db, user_a):
    """P1-3 + 基础校验：rename API 必须拒绝空标题和超长标题（之前已有，顺带回归）。"""
    import pytest
    from fastapi import HTTPException
    from app.models import ConversationSession
    from app.api.v1.agent import rename_session
    from app.api.v1.agent import RenameSessionRequest

    sess = ConversationSession(
        user_id=user_a.id, title="原", source="web",
        bot_id=None, chat_id=None, platform_user_id=None, chat_type=None,
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    # 空
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title=""), user_a, db)
    assert exc.value.status_code == 422

    # 纯空白
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title="   "), user_a, db)
    assert exc.value.status_code == 422

    # 超长
    with pytest.raises(HTTPException) as exc:
        await rename_session(sess.id, RenameSessionRequest(title="x" * 301), user_a, db)
    assert exc.value.status_code == 422
