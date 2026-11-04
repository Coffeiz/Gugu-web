"""为会话消息迁移到持久化顺序水位。

Revision ID: 20261029000001
Revises: 20261028000002
"""
from alembic import op
import sqlalchemy as sa


revision = "20261029000001"
down_revision = "20261028000002"
branch_labels = None
depends_on = None
bootstrap_on_legacy_database = True


def upgrade() -> None:
    op.add_column(
        "conversation_sessions",
        sa.Column("last_message_seq", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "conversation_sessions",
        sa.Column("baseline_message_seq", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("conversation_seq", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("history_anchor_seq", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("covers_until_seq", sa.BigInteger(), nullable=True),
    )

    # 旧消息 ID 本来就是单调持久分配的顺序号；直接把它迁为会话事件序号，
    # 旧压缩水位和摘要覆盖水位因此可以无损转换。
    op.execute(sa.text(
        "UPDATE conversation_messages SET conversation_seq = id"
    ))
    op.execute(sa.text(
        "UPDATE conversation_messages SET covers_until_seq = covers_until_id "
        "WHERE covers_until_id IS NOT NULL"
    ))
    op.execute(sa.text(
        "UPDATE conversation_sessions SET baseline_message_seq = baseline_message_id"
    ))
    op.execute(sa.text(
        "UPDATE conversation_sessions SET last_message_seq = COALESCE(("
        "SELECT MAX(conversation_seq) FROM conversation_messages "
        "WHERE conversation_messages.session_id = conversation_sessions.id"
        "), 0)"
    ))
    # 物理保留策略可能已删除序号最大的正文；新计数器仍须越过 baseline/摘要水位，
    # 否则新消息会因 seq 不大于历史水位而永远不进入上下文。
    op.execute(sa.text(
        "UPDATE conversation_sessions SET last_message_seq = "
        "CASE WHEN last_message_seq < baseline_message_seq "
        "THEN baseline_message_seq ELSE last_message_seq END"
    ))
    op.execute(sa.text(
        "UPDATE conversation_sessions SET last_message_seq = CASE "
        "WHEN last_message_seq < COALESCE((SELECT MAX(covers_until_seq) "
        "FROM conversation_messages WHERE conversation_messages.session_id = conversation_sessions.id), 0) "
        "THEN COALESCE((SELECT MAX(covers_until_seq) FROM conversation_messages "
        "WHERE conversation_messages.session_id = conversation_sessions.id), 0) "
        "ELSE last_message_seq END"
    ))

    dialect = op.get_bind().dialect.name
    if dialect == "postgresql":
        op.execute(sa.text(
            "UPDATE conversation_sessions SET session_context = "
            "((session_context::jsonb - 'history_baseline_message_id') || "
            "jsonb_build_object('history_baseline_message_seq', "
            "session_context::jsonb->'history_baseline_message_id'))::json "
            "WHERE session_context IS NOT NULL "
            "AND session_context::jsonb ? 'history_baseline_message_id'"
        ))
    elif dialect == "sqlite":
        op.execute(sa.text(
            "UPDATE conversation_sessions SET session_context = "
            "json_set(json_remove(session_context, '$.history_baseline_message_id'), "
            "'$.history_baseline_message_seq', "
            "json_extract(session_context, '$.history_baseline_message_id')) "
            "WHERE session_context IS NOT NULL "
            "AND json_type(session_context, '$.history_baseline_message_id') IS NOT NULL"
        ))
    else:
        raise RuntimeError(f"不支持会话顺序迁移的数据库方言：{dialect}")

    op.drop_index("ix_conversation_sessions_baseline_message_id", table_name="conversation_sessions")
    with op.batch_alter_table("conversation_messages") as batch:
        batch.alter_column("conversation_seq", existing_type=sa.BigInteger(), nullable=False)
        batch.drop_column("covers_until_id")
    with op.batch_alter_table("conversation_sessions") as batch:
        batch.alter_column(
            "baseline_message_seq",
            existing_type=sa.BigInteger(),
            nullable=False,
            server_default="0",
        )
        batch.drop_column("baseline_message_id")

    op.create_index(
        "ix_conversation_sessions_baseline_message_seq",
        "conversation_sessions",
        ["baseline_message_seq"],
    )
    op.create_index(
        "uq_conversation_messages_session_sequence",
        "conversation_messages",
        ["session_id", "conversation_seq"],
        unique=True,
    )


def downgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "postgresql":
        op.execute(sa.text(
            "UPDATE conversation_sessions SET session_context = "
            "((session_context::jsonb - 'history_baseline_message_seq') || "
            "jsonb_build_object('history_baseline_message_id', "
            "session_context::jsonb->'history_baseline_message_seq'))::json "
            "WHERE session_context IS NOT NULL "
            "AND session_context::jsonb ? 'history_baseline_message_seq'"
        ))
    elif dialect == "sqlite":
        op.execute(sa.text(
            "UPDATE conversation_sessions SET session_context = "
            "json_set(json_remove(session_context, '$.history_baseline_message_seq'), "
            "'$.history_baseline_message_id', "
            "json_extract(session_context, '$.history_baseline_message_seq')) "
            "WHERE session_context IS NOT NULL "
            "AND json_type(session_context, '$.history_baseline_message_seq') IS NOT NULL"
        ))
    else:
        raise RuntimeError(f"不支持会话顺序迁移回滚的数据库方言：{dialect}")

    op.drop_index("uq_conversation_messages_session_sequence", table_name="conversation_messages")
    op.drop_index("ix_conversation_sessions_baseline_message_seq", table_name="conversation_sessions")
    op.add_column(
        "conversation_sessions",
        sa.Column("baseline_message_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "conversation_messages",
        sa.Column("covers_until_id", sa.Integer(), nullable=True),
    )
    op.execute(sa.text(
        "UPDATE conversation_sessions SET baseline_message_id = baseline_message_seq"
    ))
    op.execute(sa.text(
        "UPDATE conversation_messages SET covers_until_id = covers_until_seq "
        "WHERE covers_until_seq IS NOT NULL"
    ))
    with op.batch_alter_table("conversation_sessions") as batch:
        batch.alter_column("baseline_message_id", existing_type=sa.Integer(), nullable=False, server_default="0")
        batch.drop_column("baseline_message_seq")
    with op.batch_alter_table("conversation_messages") as batch:
        batch.drop_column("history_anchor_seq")
        batch.drop_column("covers_until_seq")
        batch.drop_column("conversation_seq")
    op.drop_column("conversation_sessions", "last_message_seq")
    op.create_index(
        "ix_conversation_sessions_baseline_message_id",
        "conversation_sessions",
        ["baseline_message_id"],
    )
