from app.api.v1.search import run_global_search
from app.models import File, Project
from agent.tools.global_search import _global_search


async def _mk(db, obj):
    db.add(obj)
    await db.commit()
    await db.refresh(obj)
    return obj


async def test_run_global_search_matches_file_ext_case_insensitively(db, user_a):
    await _mk(db, File(user_id=user_a.id, display_name="prototype", ext="HTML",
                       storage_key="k", size=100))

    result = await run_global_search(db, user_a.id, "html")

    assert result["total"] == 1
    assert result["groups"][0]["type"] == "file"
    assert result["groups"][0]["items"][0]["title"] == "prototype.HTML"


async def test_run_global_search_isolates_by_user(db, user_a, user_b):
    await _mk(db, File(user_id=user_b.id, display_name="secret", ext="md",
                       storage_key="k", size=10))

    result = await run_global_search(db, user_a.id, "secret")

    assert result["total"] == 0


async def test_run_global_search_types_filter_narrows_result(db, user_a):
    await _mk(db, Project(user_id=user_a.id, name="speedream"))
    await _mk(db, File(user_id=user_a.id, display_name="speedream", ext="md",
                       storage_key="k", size=10))

    all_result = await run_global_search(db, user_a.id, "speedream")
    file_only = await run_global_search(db, user_a.id, "speedream", types=["file"])

    assert {g["type"] for g in all_result["groups"]} == {"project", "file"}
    assert {g["type"] for g in file_only["groups"]} == {"file"}


async def test_run_global_search_per_type_limit_applies(db, user_a):
    for i in range(10):
        await _mk(db, File(user_id=user_a.id, display_name=f"report-{i}", ext="md",
                           storage_key="k", size=10))

    result = await run_global_search(db, user_a.id, "report", per_type=3)

    assert len(result["groups"][0]["items"]) == 3


async def test_global_search_tool_requires_query(db, user_a):
    res = await _global_search(db, user_a.id, {})

    assert res == {"error": "需要提供搜索关键词 q"}


async def test_global_search_tool_adds_note_when_nothing_found(db, user_a):
    res = await _global_search(db, user_a.id, {"q": "找不到的东西"})

    assert res["total"] == 0
    assert "不搜文件内容" in res["note"]


async def test_global_search_tool_ignores_unknown_types(db, user_a):
    await _mk(db, File(user_id=user_a.id, display_name="prototype", ext="html",
                       storage_key="k", size=10))

    res = await _global_search(db, user_a.id, {"q": "prototype", "types": ["file", "bogus"]})

    assert res["total"] == 1
    assert res["groups"][0]["type"] == "file"
