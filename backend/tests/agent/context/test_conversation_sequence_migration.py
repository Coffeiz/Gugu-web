"""会话顺序迁移无损搬运旧水位，并为清理过的历史保住追加计数器。"""

import importlib.util
import json
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_conversation_sequence_migration_preserves_watermarks_and_rewrites_context():
    path = Path(__file__).resolve().parents[3] / "alembic/versions/20261029000001_add_conversation_sequence.py"
    spec = importlib.util.spec_from_file_location("conversation_sequence_revision", path)
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)

    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sessions = sa.Table(
        "conversation_sessions", metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("baseline_message_id", sa.Integer, nullable=False, server_default="0"),
        sa.Column("session_context", sa.JSON),
    )
    messages = sa.Table(
        "conversation_messages", metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("session_id", sa.Integer, nullable=False),
        sa.Column("covers_until_id", sa.Integer),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        sa.Index(
            "ix_conversation_sessions_baseline_message_id",
            sessions.c.baseline_message_id,
        ).create(connection)
        connection.execute(sessions.insert(), [
            {"id": 1, "baseline_message_id": 20,
             "session_context": {"history_baseline_message_id": 18, "locale": "zh-CN"}},
            {"id": 2, "baseline_message_id": 0, "session_context": None},
        ])
        connection.execute(messages.insert(), [
            {"id": 10, "session_id": 1, "covers_until_id": None},
            {"id": 15, "session_id": 1, "covers_until_id": 17},
            {"id": 99, "session_id": 2, "covers_until_id": None},
        ])
        revision.op = Operations(MigrationContext.configure(connection))
        revision.upgrade()

        migrated_sessions = connection.execute(sa.text(
            "SELECT id, baseline_message_seq, last_message_seq, session_context "
            "FROM conversation_sessions ORDER BY id"
        )).mappings().all()
        migrated_messages = connection.execute(sa.text(
            "SELECT id, conversation_seq, covers_until_seq "
            "FROM conversation_messages ORDER BY id"
        )).mappings().all()
        assert migrated_sessions[0]["baseline_message_seq"] == 20
        assert migrated_sessions[0]["last_message_seq"] == 20
        assert json.loads(migrated_sessions[0]["session_context"]) == {
            "locale": "zh-CN", "history_baseline_message_seq": 18,
        }
        assert migrated_sessions[1]["last_message_seq"] == 99
        assert [row["conversation_seq"] for row in migrated_messages] == [10, 15, 99]
        assert migrated_messages[1]["covers_until_seq"] == 17
        assert "baseline_message_id" not in sa.inspect(connection).get_columns("conversation_sessions")
        assert "covers_until_id" not in sa.inspect(connection).get_columns("conversation_messages")
        indexes = sa.inspect(connection).get_indexes("conversation_messages")
        assert any(index["name"] == "uq_conversation_messages_session_sequence" for index in indexes)

        revision.downgrade()
        restored = connection.execute(sa.text(
            "SELECT baseline_message_id, session_context FROM conversation_sessions WHERE id = 1"
        )).mappings().one()
        assert restored["baseline_message_id"] == 20
        assert json.loads(restored["session_context"]) == {
            "locale": "zh-CN", "history_baseline_message_id": 18,
        }
        assert "conversation_seq" not in sa.inspect(connection).get_columns("conversation_messages")
