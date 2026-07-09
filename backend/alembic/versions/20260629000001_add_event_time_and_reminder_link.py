"""add time to calendar_events + event_id link on scheduled_tasks（活动加时间 + 绑定提醒任务）

Revision ID: 20260629000001
Revises: 20260628000001
Create Date: 2026-06-29

幂等：ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS（见 deploy.md §10.2）。
event_id 故意不建 DB 外键，级联删由应用层处理（_delete_event 删事件时连带删其提醒任务）。
"""
from alembic import op

revision = '20260629000001'
down_revision = '20260628000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS time VARCHAR(5)")
    op.execute("ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS event_id INTEGER")
    op.execute("CREATE INDEX IF NOT EXISTS ix_scheduled_tasks_event_id ON scheduled_tasks (event_id)")


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_scheduled_tasks_event_id")
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS event_id")
    op.execute("ALTER TABLE calendar_events DROP COLUMN IF EXISTS time")
