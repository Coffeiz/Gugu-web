"""为共享终端补充 Run 关联字段。"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260826000006"
down_revision: str | None = "20260826000005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    session_columns = {column["name"] for column in inspector.get_columns("terminal_sessions")}
    if "run_id" not in session_columns:
        op.add_column("terminal_sessions", sa.Column("run_id", sa.String(length=64), nullable=True))
    session_indexes = {item["name"] for item in inspector.get_indexes("terminal_sessions")}
    if "ix_terminal_sessions_run_id" not in session_indexes:
        op.create_index("ix_terminal_sessions_run_id", "terminal_sessions", ["run_id"])
    event_columns = {column["name"] for column in inspector.get_columns("terminal_events")}
    if "run_id" not in event_columns:
        op.add_column("terminal_events", sa.Column("run_id", sa.String(length=64), nullable=True))
    event_indexes = {item["name"] for item in inspector.get_indexes("terminal_events")}
    if "ix_terminal_events_run_id" not in event_indexes:
        op.create_index("ix_terminal_events_run_id", "terminal_events", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_terminal_events_run_id", table_name="terminal_events")
    op.drop_column("terminal_events", "run_id")
    op.drop_index("ix_terminal_sessions_run_id", table_name="terminal_sessions")
    op.drop_column("terminal_sessions", "run_id")
