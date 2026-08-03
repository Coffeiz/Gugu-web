"""保存 QQ 群成员工具白名单。"""

from alembic import op


revision = "20260803000003"
down_revision = "20260803000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS "
        "group_allowed_tools JSONB NOT NULL DEFAULT '[\"web_search\"]'::jsonb"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots DROP COLUMN IF EXISTS group_allowed_tools")
