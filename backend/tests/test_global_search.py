from datetime import datetime, timezone

from app.api.v1.search import _run_ilike_search, run_global_search
from app.models import File, Folder, MindCanvasItem, MindMap, MindNode, Project, ScheduledTask, UserMcpServer, UserSkill
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


async def test_ilike_global_search_excludes_deleted_folders(db, user_a):
    live = await _mk(db, Folder(user_id=user_a.id, name="音乐"))
    await _mk(db, Folder(
        user_id=user_a.id,
        name="音乐",
        deleted_at=datetime.now(timezone.utc),
    ))

    result = await _run_ilike_search(db, user_a.id, "音乐", types=["folder"])

    assert result["total"] == 1
    assert result["groups"][0]["type"] == "folder"
    assert len(result["groups"][0]["items"]) == 1
    assert result["groups"][0]["items"][0]["id"] == live.id
    assert result["groups"][0]["items"][0]["subtitle"] == "个人 · 音乐"

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


async def test_global_search_returns_canvas_note_and_canvas_location(db, user_a):
    canvas = await _mk(db, MindMap(user_id=user_a.id, title="工作画布"))
    note = await _mk(db, MindNode(
        user_id=user_a.id, kind="canvas_note", title="Worker 调度逻辑",
        content_md="worker.py 消费 im:inbound 调 Agent 回 IM",
        content_plain="worker.py 消费 im:inbound 调 Agent 回 IM",
    ))
    await _mk(db, MindCanvasItem(user_id=user_a.id, canvas_id=canvas.id, node_id=note.id, x=12, y=34))

    result = await _run_ilike_search(db, user_a.id, "Worker", types=["canvas_note"])

    assert result["total"] == 1
    assert result["groups"][0]["type"] == "canvas_note"
    assert result["groups"][0]["items"][0]["id"] == note.id
    assert result["groups"][0]["items"][0]["canvas_id"] == canvas.id


async def test_global_search_canvas_note_respects_user_and_soft_delete(db, user_a, user_b):
    own_canvas = await _mk(db, MindMap(user_id=user_a.id, title="我的画布"))
    other_canvas = await _mk(db, MindMap(user_id=user_b.id, title="他人画布"))
    own_note = await _mk(db, MindNode(
        user_id=user_a.id, kind="canvas_note", title="检索词便签", content_plain="检索词正文",
    ))
    private_note = await _mk(db, MindNode(
        user_id=user_b.id, kind="canvas_note", title="检索词私密", content_plain="检索词正文",
    ))
    deleted_note = await _mk(db, MindNode(
        user_id=user_a.id, kind="canvas_note", title="检索词已删除", content_plain="检索词正文",
        deleted_at=datetime.now(timezone.utc),
    ))
    for canvas, note in ((own_canvas, own_note), (other_canvas, private_note), (own_canvas, deleted_note)):
        await _mk(db, MindCanvasItem(user_id=canvas.user_id, canvas_id=canvas.id, node_id=note.id))

    result = await _run_ilike_search(db, user_a.id, "检索词", types=["canvas_note"])

    assert [item["id"] for item in result["groups"][0]["items"]] == [own_note.id]


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


async def test_global_search_finds_owned_user_skill_without_exposing_body(db, user_a, user_b):
    await _mk(db, UserSkill(
        owner_id=user_a.id,
        slug="f1-data",
        name="F1 数据分析",
        description_short="整理排位和圈速数据",
        body="这是不应进入全局搜索结果的 Skill 正文",
        related_tools=["create_file"],
        content_digest="digest-a",
    ))
    await _mk(db, UserSkill(
        owner_id=user_b.id,
        slug="private-f1",
        name="私有 F1 技能",
        description_short="别人的 Skill",
        body="secret",
        related_tools=[],
        content_digest="digest-b",
    ))

    result = await run_global_search(db, user_a.id, "F1", types=["skill"])

    assert result["total"] == 1
    assert result["groups"][0]["type"] == "skill"
    item = result["groups"][0]["items"][0]
    assert item["title"] == "F1 数据分析"
    assert item["slug"] == "f1-data"
    assert "body" not in item


async def test_global_search_mcp_and_scheduled_task_queries_stay_owner_scoped(db, user_a, user_b):
    await _mk(db, UserMcpServer(
        user_id=user_a.id, scope="user", name="闲鱼服务", endpoint="https://example.test/mcp",
    ))
    await _mk(db, UserMcpServer(
        user_id=user_b.id, scope="user", name="闲鱼私有服务", endpoint="https://example.test/private",
    ))
    await _mk(db, ScheduledTask(
        user_id=user_a.id, name="闲鱼上新", payload="检查商品", cron="0 9 * * *", enabled=True,
    ))
    await _mk(db, ScheduledTask(
        user_id=user_b.id, name="闲鱼私人任务", payload="不可见", cron="0 9 * * *", enabled=True,
    ))

    mcp_result = await _run_ilike_search(db, user_a.id, "闲鱼", types=["mcp"])
    task_result = await _run_ilike_search(db, user_a.id, "闲鱼", types=["scheduled_task"])

    assert [item["title"] for item in mcp_result["groups"][0]["items"]] == ["闲鱼服务"]
    assert [item["title"] for item in task_result["groups"][0]["items"]] == ["闲鱼上新"]


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
