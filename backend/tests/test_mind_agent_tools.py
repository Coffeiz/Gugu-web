"""咕咕思维工具：只读、受限块写入、软删恢复与用户隔离。"""
from app.core.mind import upsert_relation
from app.models import MindNode, Project
from agent.tools.mind import (
    _create_note, _delete_note, _note_get, _note_search, _restore_note, _undo_last_gugu_note,
    _update_note,
)


async def _mk_note(db, user, text: str, title: str | None = None) -> MindNode:
    node = MindNode(user_id=user.id, kind="note", title=title, content_md=text, content_plain=text)
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def test_note_search_returns_matches_and_one_hop_neighbors(db, user_a):
    matched = await _mk_note(db, user_a, "发布前需要完成回归测试", "发布清单")
    neighbor = await _mk_note(db, user_a, "测试通过后再安排上线")
    await upsert_relation(db, user_a.id, matched.id, neighbor.id)

    result = await _note_search(db, user_a.id, {"q": "发布"})

    assert result["count"] == 1
    assert result["matches"][0]["node_id"] == matched.id
    assert result["related"] == [{
        "from_node_id": matched.id,
        "relation_id": result["related"][0]["relation_id"],
        "type": "related",
        "status": "confirmed",
        "origin": "user",
        "note": None,
        "node": result["related"][0]["node"],
    }]
    assert result["related"][0]["node"]["node_id"] == neighbor.id


async def test_note_search_accepts_unified_query_alias(db, user_a):
    matched = await _mk_note(db, user_a, "统一搜索参数", "搜索参数")

    result = await _note_search(db, user_a.id, {"query": "统一搜索"})

    assert result["matches"][0]["node_id"] == matched.id


async def test_note_search_accepts_multiple_keywords(db, user_a):
    await _mk_note(db, user_a, "部署方案", "部署")
    await _mk_note(db, user_a, "上线清单", "上线")

    result = await _note_search(db, user_a.id, {"queries": ["部署", "上线"]})

    assert {match["title"] for match in result["matches"]} == {"部署", "上线"}


async def test_note_search_skips_deleted_and_other_users_nodes(db, user_a, user_b):
    deleted = await _mk_note(db, user_a, "秘密计划")
    deleted.deleted_at = deleted.created_at
    await db.commit()
    await _mk_note(db, user_b, "秘密计划")

    result = await _note_search(db, user_a.id, {"q": "秘密"})

    assert result["count"] == 0
    assert result["matches"] == []


async def test_note_get_returns_full_content_and_neighbor(db, user_a):
    node = await _mk_note(db, user_a, "# 完整正文\n\n这是完整内容", "一条笔记")
    neighbor = await _mk_note(db, user_a, "关联笔记")
    await upsert_relation(db, user_a.id, node.id, neighbor.id)

    result = await _note_get(db, user_a.id, {"node_id": node.id})

    assert result["node"]["content_md"] == "# 完整正文\n\n这是完整内容"
    assert result["node"]["numbered_content"] == "1: # 完整正文\n2: \n3: 这是完整内容"
    assert result["related"][0]["node"]["node_id"] == neighbor.id


async def test_note_get_hides_other_users_node(db, user_a, user_b):
    node = await _mk_note(db, user_b, "不该泄露")

    result = await _note_get(db, user_a.id, {"node_id": node.id})

    assert result == {"error": "找不到这条思维节点"}


async def test_create_note_serializes_supported_blocks_and_references(db, user_a):
    project = Project(user_id=user_a.id, name="星尘计划")
    db.add(project)
    await db.commit()
    await db.refresh(project)

    result = await _create_note(db, user_a.id, {
        "title": "发布准备",
        "color": "teal",
        "blocks": [
            {"type": "paragraph", "content": [
                {"type": "text", "text": "先完成", "marks": [{"type": "bold"}]},
                {"type": "text", "text": " "},
                {"type": "reference", "ref_type": "project", "ref_id": project.id, "label": project.name},
            ]},
            {"type": "task_list", "items": [
                {"content": [{"type": "text", "text": "跑回归"}], "checked": False},
            ]},
        ],
    })

    note = result["note"]
    assert note["origin"] == "gugu"
    assert note["color"] == "teal"
    assert "**先完成** [[project:" in note["content_md"]
    assert "- [ ] 跑回归" in note["content_md"]


async def test_create_note_rejects_invalid_color_and_other_users_reference(db, user_a, user_b):
    user_a_id = user_a.id
    user_b_id = user_b.id
    bad_color = await _create_note(db, user_a_id, {
        "color": "purple", "blocks": [{"type": "paragraph", "content": []}],
    })
    assert "色板" in bad_color["error"]

    project = Project(user_id=user_b_id, name="别人的项目")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    foreign_ref = await _create_note(db, user_a_id, {
        "blocks": [{"type": "paragraph", "content": [
            {"type": "reference", "ref_type": "project", "ref_id": project.id, "label": project.name},
        ]}],
    })
    assert foreign_ref == {"error": "引用对象不存在"}


async def test_update_note_appends_without_exposing_version(db, user_a):
    created = await _create_note(db, user_a.id, {
        "blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "第一段"}]}],
    })
    note = created["note"]
    updated = await _update_note(db, user_a.id, {
        "node_id": note["node_id"], "color": "amber",
        "append_blocks": [{"type": "bullet_list", "items": [{"content": [{"type": "text", "text": "第二项"}]}]}],
    })
    assert updated["note"]["color"] == "amber"
    assert updated["note"]["content_md"] == "第一段\n\n- 第二项"

    updated = await _update_note(db, user_a.id, {
        "node_id": note["node_id"], "title": "增量标题",
    })
    assert updated["note"]["title"] == "增量标题"


async def test_delete_reads_current_version_and_restore_returns_note(db, user_a):
    created = await _create_note(db, user_a.id, {
        "blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "待删"}]}],
    })
    note = created["note"]
    deleted = await _delete_note(db, user_a.id, {"node_id": note["node_id"]})
    assert deleted == {"deleted_node_id": note["node_id"], "can_restore": True}
    restored = await _restore_note(db, user_a.id, {"node_id": note["node_id"]})
    assert restored["note"]["node_id"] == note["node_id"]
    assert "version" not in restored["note"]


async def test_undo_last_gugu_note_never_deletes_user_note(db, user_a):
    user_note = await _mk_note(db, user_a, "用户自己写的")
    created = await _create_note(db, user_a.id, {
        "blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "咕咕记录"}]}],
    })

    undone = await _undo_last_gugu_note(db, user_a.id, {})

    assert undone["deleted_node_id"] == created["note"]["node_id"]
    await db.refresh(user_note)
    assert user_note.deleted_at is None
