"""为项目和日历事件增加可恢复软删除状态。"""
from alembic import op
import sqlalchemy as sa


revision = "20260909000002"
down_revision = "20260909000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("calendar_events", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_projects_deleted_at", "projects", ["deleted_at"])
    op.create_index("ix_calendar_events_deleted_at", "calendar_events", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_calendar_events_deleted_at", table_name="calendar_events")
    op.drop_index("ix_projects_deleted_at", table_name="projects")
    op.drop_column("calendar_events", "deleted_at")
    op.drop_column("projects", "deleted_at")
