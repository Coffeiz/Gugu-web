"""@ 引用上下文：文件块必须带 id 与所在目录，咕咕才能直接定位文件而非按名搜索。"""
from __future__ import annotations

from datetime import timezone

import pytest

from agent.context.history import build_history_parts
from agent.context.session_history import load_session_history
from agent.context.references import build_reference_context
from app.models import ConversationMessage, ConversationSession, File, Folder, MindNode


@pytest.fixture
async def folder_with_file(db, user_a):
    folder = Folder(user_id=user_a.id, name="插画参考")
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    file = File(
        user_id=user_a.id,
        display_name="ZenlessZoneZero Screenshot 2024.07.08 - 11.00.27.87",
        ext="png",
        space="personal",
        folder_id=folder.id,
        storage_key="personal/test/screenshot.png",
        mime_type="image/png",
    )
    db.add(file)
    await db.commit()
    await db.refresh(file)
    return folder, file


async def test_file_reference_includes_id_and_folder_path(db, user_a, folder_with_file):
    folder, file = folder_with_file
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": file.display_name}],
    )
    assert f"文件 id：{file.id}" in context
    assert "目录：插画参考（folder_id=" in context
    assert f"folder_id={folder.id}" in context
    assert ".png" in context


async def test_file_reference_without_folder_reports_space_root(db, user_a):
    file = File(
        user_id=user_a.id, display_name="loose", ext="txt",
        space="personal", folder_id=None, storage_key="personal/loose.txt",
        mime_type="text/plain",
    )
    db.add(file)
    await db.commit()
    await db.refresh(file)
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": "loose"}],
    )
    assert f"文件 id：{file.id}" in context
    assert "空间根目录" in context


async def test_canvas_note_reference_includes_owned_note_content(db, user_a):
    note = MindNode(
        user_id=user_a.id, kind="canvas_note", title="调度逻辑",
        content_md="worker.py 负责消费队列", content_plain="worker.py 负责消费队列",
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)

    context = await build_reference_context(
        db, user_a.id, [{"type": "canvas_note", "id": note.id, "label": note.title}],
    )

    assert "[画布便签]" in context
    assert f"便签 id：{note.id}" in context
    assert "worker.py 负责消费队列" in context


async def test_deleted_file_reference_is_ignored(db, user_a, folder_with_file):
    from datetime import timedelta

    _folder, file = folder_with_file
    file.deleted_at = file.created_at + timedelta(minutes=1)
    await db.commit()
    context = await build_reference_context(
        db, user_a.id, [{"type": "file", "id": file.id, "label": "gone"}],
    )
    assert context == ""


async def test_other_users_file_reference_is_ignored(db, user_a, user_b, folder_with_file):
    _folder, file = folder_with_file
    context = await build_reference_context(
        db, user_b.id, [{"type": "file", "id": file.id, "label": "stolen"}],
    )
    assert context == ""


async def test_folder_reference_lists_path_and_contents(db, user_a, folder_with_file):
    folder, _file = folder_with_file
    context = await build_reference_context(db, user_a.id, [{"type": "folder", "id": folder.id}])
    assert "[文件夹]" in context
    assert f"目录 id：{folder.id}" in context
    assert "插画参考" in context
    assert "内含文件：ZenlessZoneZero" in context


async def test_folder_reference_cross_user_ignored(db, user_a, user_b):
    other = Folder(user_id=user_b.id, name="别人的目录")
    db.add(other)
    await db.flush()
    context = await build_reference_context(db, user_a.id, [{"type": "folder", "id": other.id}])
    assert context == ""


async def test_conversation_reference_uses_message_id_and_checks_session_owner(db, user_a, user_b):
    session = ConversationSession(user_id=user_a.id, title="原会话", source="web")
    db.add(session)
    await db.flush()
    message = ConversationMessage(
        session_id=session.id, role="user", content="被引用的原消息",
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)

    context = await build_reference_context(
        db, user_a.id, [{"type": "conversation", "id": message.id, "label": "原消息"}],
    )
    assert f"消息 id：{message.id}" in context
    assert f"会话 id：{session.id}" in context
    assert "被引用的原消息" in context

    assert await build_reference_context(
        db, user_b.id, [{"type": "conversation", "id": message.id, "label": "原消息"}],
    ) == ""


async def test_old_message_replays_reference_context_from_references_json(
    db, user_a, folder_with_file,
):
    _folder, file = folder_with_file
    session = ConversationSession(user_id=user_a.id, title="旧引用会话", source="web")
    db.add(session)
    await db.flush()
    db.add(ConversationMessage(
        session_id=session.id,
        role="user",
        content="更新下文档",
        references_json=[{"type": "file", "id": file.id, "label": file.display_name}],
    ))
    await db.commit()

    history = await load_session_history(db, session.id)
    parts = build_history_parts(
        history, type("Request", (), {"chat_id": None})(),
        use_anthropic=False, user_tz=timezone.utc,
    )
    rendered = str(parts)
    assert f"文件 id：{file.id}" in rendered
    assert "更新下文档" in rendered

    time_index = next(
        index for index, item in enumerate(parts)
        if item["role"] == "user"
        and isinstance(item["content"], list)
        and item["content"]
        and item["content"][0].get("type") == "time-context"
    )
    reference_index = next(
        index for index, item in enumerate(parts)
        if item["role"] == "user"
        and isinstance(item["content"], list)
        and any(block.get("scope") == "explicit-reference" for block in item["content"])
    )
    assert time_index < reference_index
    reference_user = parts[reference_index]
    assert reference_user["content"][0]["scope"] == "explicit-reference"
    assert reference_user["content"][1] == {"type": "text", "text": "更新下文档"}


def test_inline_reference_history_keeps_reference_before_user_text():
    message = type("Message", (), {
        "role": "user",
        "content": "更新下文档",
        "content_json": [
            {
                "type": "knowledge-context",
                "scope": "explicit-reference",
                "text": "文件 id：123",
            },
            {"type": "text", "text": "更新下文档"},
        ],
        "files": None,
        "quoted_text": None,
        "sent_at": None,
    })()
    parts = build_history_parts(
        [message], type("Request", (), {"chat_id": None})(),
        use_anthropic=False, user_tz=timezone.utc,
    )
    user = next(item for item in parts if item["role"] == "user" and isinstance(item["content"], list))
    assert user["content"][0]["scope"] == "explicit-reference"
    assert user["content"][1] == {"type": "text", "text": "更新下文档"}
