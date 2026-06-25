"""drop projects.notes（移除项目备注功能）

Revision ID: 20260625000001
Revises: 20260623000003
Create Date: 2026-06-25

项目「备注」功能整体下线：模型/schema/API/agent 工具/前端均已移除，这里把列也删掉。
幂等：DROP COLUMN IF EXISTS——本地手删过的跳过，服务器/全新 DB 正常删。
⚠️ 此操作会删除各项目已存的备注文本，不可逆（downgrade 只重建空列，不恢复数据）。
"""
from alembic import op
import sqlalchemy as sa

revision = '20260625000001'
down_revision = '20260623000003'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE projects DROP COLUMN IF EXISTS notes")


def downgrade():
    # 仅重建空列（NOT NULL + 默认空串），无法找回已删数据
    op.execute("ALTER TABLE projects ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''")
