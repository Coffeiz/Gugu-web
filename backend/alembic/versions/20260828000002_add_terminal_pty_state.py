"""增加终端 PTY 模式和运行快照字段。"""

from alembic import op
import sqlalchemy as sa


revision = "20260828000002"
down_revision = "20260828000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("terminal_sessions"):
        return
    columns = {column["name"] for column in inspector.get_columns("terminal_sessions")}
    additions = (
        ("mode", sa.String(length=24), "agent-events"),
        ("pty_pid", sa.Integer(), None),
        ("pty_sandbox_id", sa.String(length=128), None),
        ("pty_cols", sa.Integer(), None),
        ("pty_rows", sa.Integer(), None),
    )
    for name, column_type, default in additions:
        if name not in columns:
            kwargs = {"nullable": True}
            if default is not None:
                kwargs["server_default"] = default
            op.add_column("terminal_sessions", sa.Column(name, column_type, **kwargs))
    op.alter_column("terminal_sessions", "mode", nullable=False, server_default="agent-events")


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("terminal_sessions"):
        return
    columns = {column["name"] for column in inspector.get_columns("terminal_sessions")}
    for name in ("pty_rows", "pty_cols", "pty_sandbox_id", "pty_pid", "mode"):
        if name in columns:
            op.drop_column("terminal_sessions", name)
