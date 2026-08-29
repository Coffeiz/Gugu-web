"""移除邀请码注册功能及其遗留数据表。"""

from alembic import op


revision = "20260823000001"
down_revision = "20260822000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("invite_codes")


def downgrade() -> None:
    op.execute(
        """CREATE TABLE invite_codes (
            id SERIAL PRIMARY KEY,
            code VARCHAR(32) NOT NULL UNIQUE,
            note VARCHAR(200),
            used_at TIMESTAMPTZ,
            used_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    op.execute("CREATE INDEX ix_invite_codes_code ON invite_codes (code)")
