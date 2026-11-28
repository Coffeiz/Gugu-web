"""保存项目过期清理的文件暂存恢复记录。"""

from alembic import op
import sqlalchemy as sa


revision = "20261115000003"
down_revision = "20261115000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_expiry_journals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("entries", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "project_id", name="uq_project_expiry_journal_owner_project"),
    )


def downgrade() -> None:
    op.drop_table("project_expiry_journals")
