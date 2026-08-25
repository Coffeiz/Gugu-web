"""增加用户 Prompt Skill 持久化表。"""

from alembic import op
import sqlalchemy as sa


revision = "20260825000001"
down_revision = "20260824000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_skills",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description_short", sa.String(length=100), nullable=False),
        sa.Column("description_long", sa.String(length=500), nullable=True),
        sa.Column("category", sa.String(length=32), nullable=False, server_default="personal"),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("related_tools", sa.JSON(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False, server_default="user"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("content_digest", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "slug", name="uq_user_skill_owner_slug"),
    )
    op.create_index("ix_user_skills_owner_id", "user_skills", ["owner_id"])
    op.create_index("ix_user_skills_enabled", "user_skills", ["enabled"])


def downgrade() -> None:
    op.drop_index("ix_user_skills_enabled", table_name="user_skills")
    op.drop_index("ix_user_skills_owner_id", table_name="user_skills")
    op.drop_table("user_skills")
