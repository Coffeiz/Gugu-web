"""上下文辅助资料应与串行 DB 读取重叠，且不共享 AsyncSession。"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from agent.im import context_loader


@pytest.mark.asyncio
async def test_independent_context_sources_overlap_db_loaders(monkeypatch):
    """记忆、IM 记忆和知识清单在项目 DB 查询等待期间启动并保留结果。"""
    all_auxiliary_started = asyncio.Event()
    started = set()

    async def begin(name, value):
        started.add(name)
        if len(started) == 3:
            all_auxiliary_started.set()
        return value

    async def load_user_tz(_db, _user_id):
        return "synthetic-tz"

    async def load_projects(_db, _user_id):
        await all_auxiliary_started.wait()
        return ["project"]

    async def load_events(_db, _user_id, *, tz):
        assert tz == "synthetic-tz"
        return ["event"]

    async def load_recent_notes(_db, _user_id):
        return ["note"]

    async def load_files_overview(_db, _user_id):
        return {"total": 1}

    async def load_style_prefs(_db, _user_id):
        return {"reply_tone": "concise"}

    async def load_im_channels(_db, _user_id):
        return {"qq": True}

    async def load_memory(_user_id, _query, *, prefer_recent):
        assert prefer_recent is True
        return await begin("memory", {"profile": "synthetic"})

    async def load_knowledge_overview(_user_id):
        return await begin("knowledge", [{"title": "synthetic"}])

    async def load_im_memory(_request):
        return await begin("im_memory", {"group": {"summary": "synthetic"}})

    for name, value in {
        "load_user_tz": load_user_tz,
        "load_projects": load_projects,
        "load_events": load_events,
        "load_recent_notes": load_recent_notes,
        "load_files_overview": load_files_overview,
        "load_style_prefs": load_style_prefs,
        "load_im_channels": load_im_channels,
        "load_memory": load_memory,
        "load_knowledge_overview": load_knowledge_overview,
    }.items():
        monkeypatch.setattr(context_loader.loaders, name, value)
    monkeypatch.setattr(context_loader, "load_im_memory", load_im_memory)

    result = await context_loader.load_context_data(
        object(), "synthetic-user", SimpleNamespace(), True,
        "synthetic-query", policy=SimpleNamespace(load_owner_context=True),
    )

    assert started == {"memory", "knowledge", "im_memory"}
    assert result.projects == ["project"]
    assert result.events == ["event"]
    assert result.memory == {"profile": "synthetic"}
    assert result.knowledge == [{"title": "synthetic"}]
    assert result.im_memory == {"group": {"summary": "synthetic"}}
