"""展示事件身份、原始时间、状态更新及本版本迁移契约。"""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from agent.context.display_timeline import finalize_display_timeline, stamp_display_item, upsert_tool_timeline_item
from app.db.migrations.display_events import migrate_display_events


def test_tool_updates_keep_first_identity_timestamp_and_sequence():
    items = []
    first = {'kind': 'tool', 'runId': 'r', 'roundId': 'q', 'toolCallId': 'a', 'toolStatus': 'running'}
    stamp_display_item(first, sequence=1, user_message_id=17)
    upsert_tool_timeline_item(items, first)
    before = {key: items[0][key] for key in ('eventId', 'createdAt', 'sequence', 'timelineOrder')}
    upsert_tool_timeline_item(items, {**first, 'toolStatus': 'success', 'toolResult': {'ok': True}})
    stamp_display_item(items[0], sequence=2, user_message_id=99)
    assert len(items) == 1
    assert {key: items[0][key] for key in before} == before
    assert items[0]['toolStatus'] == 'success'
    assert items[0]['anchorMessageId'] == 17


def test_sealing_run_only_changes_open_tool_status_and_keeps_identity_time_order():
    source = [stamp_display_item({'kind': 'tool', 'toolStatus': 'running', 'runId': 'r', 'roundId': 'q'}, sequence=1, user_message_id=17)]
    sealed = finalize_display_timeline(source)
    assert sealed[0]['toolStatus'] == 'stopped'
    assert source[0]['toolStatus'] == 'running'
    for key in ('eventId', 'sequence', 'anchorMessageId', 'createdAt', 'timelineOrder', 'runId', 'roundId'):
        assert sealed[0][key] == source[0][key]
    assert finalize_display_timeline(sealed) == sealed


def test_version_migration_is_idempotent_preserves_content_and_assigns_all_metadata():
    timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    user = SimpleNamespace(id=10, session_id=1, role='user', content_json=None, display_timeline=None, content='合成问题', files=None, run_id=None, round_id=None, created_at=timestamp)
    reply = SimpleNamespace(id=12, session_id=1, role='assistant', content_json=None, content='最终正文', files=[{'file_id': 4}], run_id='run-a', round_id=None, created_at=timestamp,
        display_timeline=[{'kind': 'assistant', 'text': '过程正文'}, {'kind': 'tool', 'toolCallId': 'a', 'toolResult': {'ok': True}}])
    raw = deepcopy(reply.display_timeline)
    result = migrate_display_events([user, reply])
    reply.display_timeline = result[12]
    assert len({event['eventId'] for event in result[12]}) == 2
    assert [event['sequence'] for event in result[12]] == [1, 2]
    assert all(event['anchorMessageId'] == 10 and event['createdAt'] == timestamp.isoformat() for event in result[12])
    assert reply.display_timeline[0]['text'] == raw[0]['text']
    assert reply.display_timeline[1]['toolResult'] == raw[1]['toolResult']
    assert reply.content == '最终正文' and reply.files == [{'file_id': 4}]
    assert migrate_display_events([user, reply]) == {}


def test_alembic_revision_migrates_real_table_and_repeating_upgrade_changes_nothing(monkeypatch):
    import importlib.util
    from pathlib import Path
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).resolve().parents[2] / 'alembic/versions/20261023000001_unify_display_events.py'
    spec = importlib.util.spec_from_file_location('display_revision', path)
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)
    engine = sa.create_engine('sqlite://')
    metadata = sa.MetaData()
    table = sa.Table('conversation_messages', metadata,
        sa.Column('id', sa.Integer, primary_key=True), sa.Column('session_id', sa.Integer),
        sa.Column('role', sa.String), sa.Column('content', sa.Text), sa.Column('content_json', sa.JSON),
        sa.Column('display_timeline', sa.JSON), sa.Column('files', sa.JSON),
        sa.Column('run_id', sa.String), sa.Column('round_id', sa.String),
        sa.Column('canonical_batch_id', sa.Integer), sa.Column('created_at', sa.DateTime))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(table.insert(), [dict(id=1, session_id=1, role='user', content='合成问题', created_at=datetime(2026, 1, 1)),
            dict(id=2, session_id=1, role='assistant', content='合成回复', created_at=datetime(2026, 1, 1))])
        monkeypatch.setattr(revision, 'op', Operations(MigrationContext.configure(connection)))
        revision.upgrade()
        first = connection.execute(sa.select(table).order_by(table.c.id)).mappings().all()
        revision.upgrade()
        second = connection.execute(sa.select(table).order_by(table.c.id)).mappings().all()
        assert first == second
        assert [row['content'] for row in second] == ['合成问题', '合成回复']
        assert second[1]['display_timeline'][0]['eventId']
        assert second[1]['display_timeline'][0]['anchorMessageId'] == 1
        with pytest.raises(RuntimeError, match='不支持仅降级代码'):
            revision.downgrade()
    engine.dispose()
