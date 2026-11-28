"""保存项目撤销文件移动的崩溃恢复记录。"""

from alembic import op
import sqlalchemy as sa


revision = "20261115000005"
down_revision = "20261115000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_undo_journals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("operation_id", sa.String(64), nullable=False),
        sa.Column("before_status", sa.String(16), nullable=False),
        sa.Column("after_status", sa.String(16), nullable=False),
        sa.Column("moves", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "operation_id", name="uq_project_undo_journal_operation"),
    )


def downgrade() -> None:
    op.drop_table("project_undo_journals")
