"""drop scheduled_tasks.action_type（移除 reminder 遗留字段）

Revision ID: 20260626000001
Revises: 20260625000001
Create Date: 2026-06-26

新版 UI 砍掉 reminder，定时任务统一交给 agent 执行 payload；action_type 沦为永远
="agent" 的死字段（前端写死、API 只允许 agent、executor 不读、deadline_scan 无实现）。
整列删除。幂等：DROP COLUMN IF EXISTS。
"""
from alembic import op

revision = '20260626000001'
down_revision = '20260625000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS action_type")


def downgrade():
    # 重建列（默认 agent），无法找回原值（本就只会是 agent）
    op.execute("ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS action_type VARCHAR(20) NOT NULL DEFAULT 'agent'")
