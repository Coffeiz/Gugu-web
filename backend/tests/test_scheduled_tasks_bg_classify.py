import app.api.v1.scheduled_tasks as st_api
from app.models import ScheduledTask


async def test_create_task_returns_immediately_without_waiting_for_classify(monkeypatch, db, user_a):
    """点创建不该等 LLM 分类调用——context_config 先是 None（安全默认），后台再补丁。"""
    called = {"n": 0}

    async def slow_classify(instruction):
        called["n"] += 1
        return {"tool_groups": ["files"], "projects": True, "calendar": False,
                "files": True, "memory": False}

    monkeypatch.setattr(st_api, "classify_context_config", slow_classify)

    body = st_api.TaskCreate(name="测试任务", payload="发我个文件", cron="0 9 * * *")
    resp = await st_api.create_task(body, user_a, db)

    assert resp["context_config"] is None   # 还没等分类结果，创建已经返回
    assert called["n"] == 0                 # 分类调用是后台调度的，create_task 本身没直接 await 它

    # 等后台任务真正跑完，验证它确实把结果补丁回了 DB
    assert len(st_api._bg_tasks) == 1
    bg_task = next(iter(st_api._bg_tasks))
    await bg_task

    t = await db.get(ScheduledTask, resp["id"])
    assert t.context_config == {"tool_groups": ["files"], "projects": True,
                                "calendar": False, "files": True, "memory": False}


async def test_update_task_payload_change_resets_then_backfills_context_config(monkeypatch, db, user_a):
    async def fake_classify(instruction):
        return {"tool_groups": ["calendar"], "projects": False, "calendar": True,
                "files": False, "memory": False}

    monkeypatch.setattr(st_api, "classify_context_config", fake_classify)

    t = ScheduledTask(user_id=user_a.id, name="任务", payload="旧指令", cron="0 9 * * *",
                      context_config={"tool_groups": ["files"], "projects": False,
                                      "calendar": False, "files": True, "memory": False})
    db.add(t)
    await db.commit()
    await db.refresh(t)

    body = st_api.TaskUpdate(payload="新指令")
    resp = await st_api.update_task(t.id, body, user_a, db)

    assert resp["context_config"] is None   # 旧配置先清空成安全默认，不留着可能过期的裁剪结果

    assert len(st_api._bg_tasks) == 1
    bg_task = next(iter(st_api._bg_tasks))
    await bg_task

    await db.refresh(t)
    assert t.context_config["tool_groups"] == ["calendar"]


async def test_bg_classify_skips_write_when_instruction_changed_again(monkeypatch, db, user_a):
    """后台分类跑完之前，指令又被改了一次——不该用旧指令算出来的结果覆盖新指令。"""
    async def fake_classify(instruction):
        return {"tool_groups": ["files"], "projects": False, "calendar": False,
                "files": True, "memory": False}

    monkeypatch.setattr(st_api, "classify_context_config", fake_classify)

    t = ScheduledTask(user_id=user_a.id, name="任务", payload="第一版指令", cron="0 9 * * *")
    db.add(t)
    await db.commit()
    await db.refresh(t)

    # 模拟：后台任务针对"第一版指令"算出的结果还没写回，但任务已经被改成"第二版指令"
    t.payload = "第二版指令"
    await db.commit()

    await st_api._apply_context_config_bg(t.id, "第一版指令")

    await db.refresh(t)
    assert t.context_config is None   # 没被旧指令的分类结果覆盖
