import io
import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.models import ChatAttachment, ConversationMessage, ConversationPendingQueue, ConversationSession, File, MindNode, Project
from app.services.data_portability.projection import (
    RECORD_SPECS, ensure_origin, ensure_portable_identities, project_record,
    write_record_stream,
)
from app.models import UserPreferences
from app.services.data_portability.producers import build_record_producers
from app.services.data_portability.identity_map import SQLitePortableIdentityMap


@pytest.mark.asyncio
async def test_projection_uses_stable_random_identity_and_explicit_project_allowlist(db, user_a):
    project = Project(user_id=user_a.id, name="迁移样例", status="active")
    db.add(project)
    await db.flush()

    origin_id = await ensure_origin(db, user_a.id)
    first = await ensure_portable_identities(db, user_id=user_a.id, origin_id=origin_id)
    portable_id = first[("project", str(project.id))]
    record = await project_record(
        db,
        user_id=user_a.id,
        origin_id=origin_id,
        spec=next(spec for spec in RECORD_SPECS if spec.record_type == "project"),
        row=project,
        identities=first,
    )
    await db.commit()

    second = await ensure_portable_identities(db, user_id=user_a.id, origin_id=origin_id)
    assert second[("project", str(project.id))] == portable_id
    assert record.portable_id == portable_id
    assert record.fields["name"] == "迁移样例"
    assert "id" not in record.fields and "user_id" not in record.fields
    assert "storage_key" not in record.fields and "api_key" not in record.fields


@pytest.mark.asyncio
async def test_projection_downgrades_reference_when_target_category_is_not_exported(db, user_a):
    target = File(
        user_id=user_a.id, display_name="说明文档", ext="md", storage_key="private/object",
    )
    db.add(target)
    await db.flush()
    node = MindNode(
        user_id=user_a.id, kind="ref", title="说明文档", content_md="引用快照",
        content_plain="引用快照", ref_type="file", ref_id=target.id,
        ref_snapshot={"summary": "引用快照"},
    )
    db.add(node)
    await db.flush()

    record = await project_record(
        db, user_id=user_a.id, origin_id=uuid4(),
        spec=next(spec for spec in RECORD_SPECS if spec.record_type == "mind_node"),
        row=node,
        identities={("mind_node", str(node.id)): "portable-node", ("file", str(target.id)): "portable-file"},
        selected_categories={"mind"},
    )

    assert record.fields["kind"] == "note"
    assert record.fields["reference_snapshot"] == {"summary": "引用快照"}
    assert record.relations == []
    assert "ref_id" not in record.fields and "storage_key" not in record.fields


@pytest.mark.asyncio
async def test_portable_identity_creation_is_scoped_to_authenticated_owner(db, user_a, user_b):
    own = Project(user_id=user_a.id, name="我的项目")
    other = Project(user_id=user_b.id, name="其他账号项目")
    db.add_all([own, other])
    await db.flush()

    origin_id = await ensure_origin(db, user_a.id)
    identities = await ensure_portable_identities(db, user_id=user_a.id, origin_id=origin_id)

    assert ("project", str(own.id)) in identities
    assert ("project", str(other.id)) not in identities

    stream = io.BytesIO()
    count = await write_record_stream(
        stream,
        db,
        user_id=user_a.id,
        origin_id=origin_id,
        identities=identities,
        spec=next(spec for spec in RECORD_SPECS if spec.record_type == "project"),
        batch_size=1,
    )
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert count == 1
    assert [line["fields"]["name"] for line in lines] == ["我的项目"]


@pytest.mark.asyncio
async def test_conversation_messages_are_owner_scoped_through_parent_session(db, user_a, user_b):
    own_session = ConversationSession(user_id=user_a.id, title="我的会话", source="web")
    foreign_session = ConversationSession(user_id=user_b.id, title="其他账号", source="web")
    db.add_all([own_session, foreign_session])
    await db.flush()
    own_message = ConversationMessage(session_id=own_session.id, role="user", content="可导出正文")
    foreign_message = ConversationMessage(session_id=foreign_session.id, role="user", content="不可导出正文")
    db.add_all([own_message, foreign_message])
    await db.flush()

    origin_id = await ensure_origin(db, user_a.id)
    identities = await ensure_portable_identities(db, user_id=user_a.id, origin_id=origin_id)
    stream = io.BytesIO()
    message_spec = next(spec for spec in RECORD_SPECS if spec.record_type == "message")
    count = await write_record_stream(
        stream, db, user_id=user_a.id, origin_id=origin_id,
        identities=identities, spec=message_spec,
    )
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]

    assert count == 1
    assert lines[0]["fields"]["content"] == "可导出正文"
    assert "不可导出正文" not in stream.getvalue().decode()
    assert "session_id" not in lines[0]["fields"]
    assert lines[0]["relations"][0]["target_portable_id"] == identities[("conversation", str(own_session.id))]


@pytest.mark.asyncio
async def test_chat_attachments_are_scoped_by_owned_parent_and_referenced_drafts(db, user_a, user_b):
    own_session = ConversationSession(user_id=user_a.id, title="自己的会话", source="web")
    foreign_session = ConversationSession(user_id=user_b.id, title="其他会话", source="web")
    db.add_all([own_session, foreign_session])
    await db.flush()
    own_message = ConversationMessage(session_id=own_session.id, role="user", content="附件")
    foreign_message = ConversationMessage(session_id=foreign_session.id, role="user", content="他人附件")
    db.add_all([own_message, foreign_message])
    await db.flush()
    own = ChatAttachment(
        attach_id="own-attached", user_id=user_a.id, message_id=own_message.id,
        storage_key=f"{user_a.id}/.chat/own", state="attached", size=3,
    )
    foreign = ChatAttachment(
        attach_id="foreign-attached", user_id=user_b.id, message_id=foreign_message.id,
        storage_key=f"{user_b.id}/.chat/foreign", state="attached", size=7,
    )
    referenced_draft = ChatAttachment(
        attach_id="own-draft", user_id=user_a.id, storage_key=f"{user_a.id}/.chat/draft",
        state="draft", size=5,
    )
    orphan_draft = ChatAttachment(
        attach_id="orphan-draft", user_id=user_a.id, storage_key=f"{user_a.id}/.chat/orphan",
        state="draft", size=6,
    )
    db.add_all([own, foreign, referenced_draft, orphan_draft])
    db.add(ConversationPendingQueue(
        user_id=user_a.id, queue_id="pending-1", session_id=own_session.id,
        items=[{"key": "draft-1", "text": "尚未发送", "attachments": [{"attach_id": "own-draft"}]}],
    ))
    await db.flush()

    origin_id = await ensure_origin(db, user_a.id)
    identities = await ensure_portable_identities(db, user_id=user_a.id, origin_id=origin_id)
    attachment_spec = next(spec for spec in RECORD_SPECS if spec.record_type == "chat_attachment")
    stream = io.BytesIO()
    count = await write_record_stream(
        stream, db, user_id=user_a.id, origin_id=origin_id,
        identities=identities, spec=attachment_spec,
        selected_categories={"conversations", "drafts"},
    )
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    exported_ids = {item["portable_id"] for item in lines}

    assert count == 2
    assert identities.get(("chat_attachment", own.attach_id)) in exported_ids
    assert identities.get(("chat_attachment", referenced_draft.attach_id)) in exported_ids
    assert identities.get(("chat_attachment", foreign.attach_id)) not in exported_ids
    assert identities.get(("chat_attachment", orphan_draft.attach_id)) not in identities
    assert "storage_key" not in stream.getvalue().decode()


@pytest.mark.asyncio
async def test_export_producers_filter_preferences_and_account_security_fields(db, user_a):
    db.add(Project(user_id=user_a.id, name="用户项目"))
    db.add(UserPreferences(user_id=user_a.id, data_json=(
        '{"locale":"zh-CN","theme":"dark","shell_dangerous_enabled":true,'
        '"smtp_password":"never-export"}'
    )))
    await db.flush()

    origin_id, _identities, producers = await build_record_producers(
        db,
        user_id=user_a.id,
        selected_categories={"account", "preferences", "projects"},
    )
    outputs = {}
    for producer in producers:
        output = io.BytesIO()
        record_count = await producer.write(output)
        outputs[producer.path] = (record_count, output.getvalue())

    account = json.loads(outputs["records/account.json"][1])
    preferences = json.loads(outputs["records/preferences.json"][1])
    projects = [json.loads(line) for line in outputs["records/projects.jsonl"][1].splitlines()]
    assert origin_id
    assert account["fields"]["username"] == user_a.username
    assert "id" not in account["fields"] and "user_id" not in account["fields"]
    assert preferences["fields"]["data"] == {"locale": "zh-CN", "theme": "dark"}
    assert len(projects) == 1 and projects[0]["fields"]["name"] == "用户项目"


@pytest.mark.asyncio
async def test_large_export_identity_lookup_uses_private_spill_map(db, user_a):
    project = Project(user_id=user_a.id, name="spill map")
    db.add(project)
    await db.flush()

    identity_map = SQLitePortableIdentityMap()
    path = identity_map.path
    origin_id, identities, producers = await build_record_producers(
        db,
        user_id=user_a.id,
        selected_categories={"projects"},
        identity_map=identity_map,
    )
    project_producer = next(item for item in producers if item.category == "projects")
    output = io.BytesIO()
    assert await project_producer.write(output) == 1
    payload = json.loads(output.getvalue().splitlines()[0])
    assert identities.get(("project", str(project.id))) == payload["portable_id"]
    assert Path(path).stat().st_mode & 0o777 == 0o600
    identity_map.close()
    assert not Path(path).exists()
