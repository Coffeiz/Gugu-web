"""为已有 Workspace 目录补齐缺失的工作区声明行。

网页创建 WorkspaceDirectory 早期没有同步创建 kind=directory 的 Workspace
声明，导致 agent 的 list_workspaces 看不到这些目录；此迁移一次性回填。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260907000006"
down_revision = "20260907000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text(
        "INSERT INTO workspaces (user_id, name, kind, directory_id, enabled, is_default, created_at, updated_at) "
        "SELECT d.user_id, d.name, 'directory', d.id, true, d.is_default, now(), now() "
        "FROM workspace_directories d "
        "WHERE d.deleted_at IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.directory_id = d.id)"
    ))


def downgrade() -> None:
    op.execute(sa.text(
        "DELETE FROM workspaces w USING workspace_directories d "
        "WHERE w.directory_id = d.id"
    ))
