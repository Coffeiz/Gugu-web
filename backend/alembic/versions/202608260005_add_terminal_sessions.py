"""共享协作终端会话和事件。"""

from alembic import op
import sqlalchemy as sa

revision = "20260826000005"
down_revision = "20260826000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("terminal_sessions"):
        op.create_table(
            "terminal_sessions",
            sa.Column("id", sa.String(length=80), primary_key=True),
            sa.Column("owner_id", sa.Uuid(), nullable=False),
            sa.Column("session_id", sa.Integer(), nullable=True),
            sa.Column("workspace_id", sa.Integer(), nullable=True),
            sa.Column("name", sa.String(length=200), nullable=False, server_default="终端"),
            sa.Column("source", sa.String(length=16), nullable=False, server_default="agent"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="idle"),
            sa.Column("shell_mode", sa.String(length=16), nullable=False, server_default="sandbox"),
            sa.Column("network_profile", sa.String(length=16), nullable=False, server_default="none"),
            sa.Column("last_sequence", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("output_chars", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["session_id"], ["conversation_sessions.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="SET NULL"),
        )
    existing_indexes = {item["name"] for item in inspector.get_indexes("terminal_sessions")} if inspector.has_table("terminal_sessions") else set()
    for name, column in (
        ("ix_terminal_sessions_owner_id", "owner_id"),
        ("ix_terminal_sessions_session_id", "session_id"),
        ("ix_terminal_sessions_workspace_id", "workspace_id"),
        ("ix_terminal_sessions_status", "status"),
    ):
        if name not in existing_indexes:
            op.create_index(name, "terminal_sessions", [column])

    if not inspector.has_table("terminal_events"):
        op.create_table(
            "terminal_events",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("terminal_id", sa.String(length=80), nullable=False),
            sa.Column("sequence", sa.Integer(), nullable=False),
            sa.Column("event_type", sa.String(length=32), nullable=False),
            sa.Column("source", sa.String(length=16), nullable=True),
            sa.Column("command", sa.Text(), nullable=True),
            sa.Column("stdout", sa.Text(), nullable=False, server_default=""),
            sa.Column("stderr", sa.Text(), nullable=False, server_default=""),
            sa.Column("exit_code", sa.Integer(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["terminal_id"], ["terminal_sessions.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("terminal_id", "sequence", name="uq_terminal_event_sequence"),
        )
    event_indexes = {item["name"] for item in inspector.get_indexes("terminal_events")} if inspector.has_table("terminal_events") else set()
    if "ix_terminal_events_terminal_id" not in event_indexes:
        op.create_index("ix_terminal_events_terminal_id", "terminal_events", ["terminal_id"])


def downgrade() -> None:
    op.drop_index("ix_terminal_events_terminal_id", table_name="terminal_events")
    op.drop_table("terminal_events")
    for name in ("ix_terminal_sessions_status", "ix_terminal_sessions_workspace_id", "ix_terminal_sessions_session_id", "ix_terminal_sessions_owner_id"):
        op.drop_index(name, table_name="terminal_sessions")
    op.drop_table("terminal_sessions")
