from app.api.v1.search import run_global_search
from app.models import File, MindNode, Project
from agent.tools.global_search import _global_search
import app.api.v1.search as search_api


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


async def test_global_search_can_fall_back_to_ilike_backend(db, user_a, monkeypatch):
    await _mk(db, File(user_id=user_a.id, display_name="兼容查询", ext="md",
                       storage_key="k", size=10))
    monkeypatch.setattr(
        search_api,
        "get_settings",
        lambda: type("Settings", (), {
            "search": type("Search", (), {"global_search_backend": "ilike"})(),
        })(),
    )

    result = await run_global_search(db, user_a.id, "兼容查询")

    assert result["groups"][0]["type"] == "file"
    assert result["groups"][0]["items"][0]["title"] == "兼容查询.md"


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


async def test_global_search_ranks_exact_and_prefix_names_before_substrings(db, user_a):
    await _mk(db, File(user_id=user_a.id, display_name="我的发布清单", ext="md",
                       storage_key="a", size=10))
    await _mk(db, File(user_id=user_a.id, display_name="发布", ext="md",
                       storage_key="b", size=10))
    await _mk(db, File(user_id=user_a.id, display_name="发布说明", ext="md",
                       storage_key="c", size=10))

    result = await run_global_search(db, user_a.id, "发布", types=["file"])

    assert [item["title"] for item in result["groups"][0]["items"]] == [
        "发布.md", "发布说明.md", "我的发布清单.md",
    ]


async def test_global_search_ranks_note_title_before_body_only_hit(db, user_a):
    await _mk(db, MindNode(
        user_id=user_a.id, kind="note", title="随手想法", content_md="", content_plain="发布复盘",
    ))
    await _mk(db, MindNode(
        user_id=user_a.id, kind="note", title="发布", content_md="", content_plain="标题命中",
    ))

    result = await run_global_search(db, user_a.id, "发布", types=["note"])

    assert result["groups"][0]["items"][0]["title"] == "发布"


async def test_global_search_tool_requires_query(db, user_a):
    res = await _global_search(db, user_a.id, {})

    assert res == {"error": "需要提供搜索关键词 query 或 queries"}

    res = await _global_search(db, user_a.id, {"queries": ["", "  "]})

    assert res == {"error": "需要提供搜索关键词 query 或 queries"}


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


async def test_global_search_or_matches_any_keyword_in_one_call(db, user_a):
    await _mk(db, Project(user_id=user_a.id, name="部署方案"))
    await _mk(db, Project(user_id=user_a.id, name="上线清单"))

    result = await run_global_search(
        db, user_a.id, "", queries=["部署", "上线"], types=["project"], mode="OR",
    )

    assert {item["title"] for item in result["groups"][0]["items"]} == {"部署方案", "上线清单"}
    assert result["queries"] == ["部署", "上线"]
    assert result["mode"] == "OR"


async def test_global_search_tool_accepts_queries_without_legacy_q(db, user_a):
    await _mk(db, Project(user_id=user_a.id, name="部署方案"))

    result = await _global_search(db, user_a.id, {"queries": ["部署"], "types": ["project"]})

    assert result["queries"] == ["部署"]
    assert result["mode"] == "OR"
    assert result["total"] == 1


async def test_global_search_and_requires_every_keyword(db, user_a):
    await _mk(db, Project(user_id=user_a.id, name="部署方案"))
    await _mk(db, Project(user_id=user_a.id, name="上线清单"))
    await _mk(db, Project(user_id=user_a.id, name="部署上线方案"))

    result = await run_global_search(
        db, user_a.id, "", queries=["部署", "上线"], types=["project"], mode="AND",
    )

    assert [item["title"] for item in result["groups"][0]["items"]] == ["部署上线方案"]
