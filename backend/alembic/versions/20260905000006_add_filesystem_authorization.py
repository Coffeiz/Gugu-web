"""新增用户沙箱完整授权记录。"""
from alembic import op
import sqlalchemy as sa


revision = "20260905000006"
down_revision = "llm23_phase3_model_policy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "filesystem_authorization_grants",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("subject_type", sa.String(length=24), server_default="session", nullable=False),
        sa.Column("subject_id", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=32), server_default="user_sandbox", nullable=False),
        sa.Column("permission", sa.String(length=32), server_default="read_write", nullable=False),
        sa.Column("granted_by", sa.String(length=16), server_default="user", nullable=False),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_filesystem_authorization_grants_user_id", "filesystem_authorization_grants", ["user_id"])
    op.create_index("ix_filesystem_authorization_grants_subject_id", "filesystem_authorization_grants", ["subject_id"])
    op.create_index(
        "ix_filesystem_grants_subject_active",
        "filesystem_authorization_grants",
        ["user_id", "subject_type", "subject_id", "revoked_at", "expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_filesystem_grants_subject_active", table_name="filesystem_authorization_grants")
    op.drop_index("ix_filesystem_authorization_grants_subject_id", table_name="filesystem_authorization_grants")
    op.drop_index("ix_filesystem_authorization_grants_user_id", table_name="filesystem_authorization_grants")
    op.drop_table("filesystem_authorization_grants")
