"""增加 Shell 工作区声明和会话绑定字段。"""

from alembic import op


revision = "20260822000004"
down_revision = "20260822000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """CREATE TABLE IF NOT EXISTS workspaces (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(200) NOT NULL,
            kind VARCHAR(20) NOT NULL DEFAULT 'folder',
            folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_workspaces_user_id ON workspaces (user_id)")
    op.execute("ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL")
    op.execute("CREATE INDEX IF NOT EXISTS ix_conversation_sessions_workspace_id ON conversation_sessions (workspace_id)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_sessions_workspace_id")
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS workspace_id")
    op.execute("DROP INDEX IF EXISTS ix_workspaces_user_id")
    op.execute("DROP TABLE IF EXISTS workspaces")
