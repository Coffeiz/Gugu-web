"""将旧用户终端迁移为交互式 PTY 模式。"""

from alembic import op
import sqlalchemy as sa


revision = "20260828000003"
down_revision = "20260828000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("terminal_sessions"):
        return
    bind.execute(sa.text(
        "UPDATE terminal_sessions SET mode = 'interactive-pty' "
        "WHERE source = 'user' AND session_id IS NULL AND mode = 'agent-events'"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("terminal_sessions"):
        return
    bind.execute(sa.text(
        "UPDATE terminal_sessions SET mode = 'agent-events' "
        "WHERE source = 'user' AND session_id IS NULL AND mode = 'interactive-pty'"
    ))
