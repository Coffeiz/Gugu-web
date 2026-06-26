"""新增 onboarding_state 表（新手引导独立子系统）

Revision ID: 20260627000001
Revises: 20260626000002
Create Date: 2026-06-27

一用户一行，状态存 JSON（seeded / *_shown / hints 等，见 onboarding/models.py）。
幂等 CREATE TABLE IF NOT EXISTS；dev 也会被启动期 create_all 自动建，这里给 prod 留迁移。
"""
from alembic import op

revision = '20260627000001'
down_revision = '20260626000002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS onboarding_state (
            user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            state      JSON,
            created_at TIMESTAMP,
            updated_at TIMESTAMP
        )
        """
    )


def downgrade():
    op.execute("DROP TABLE IF EXISTS onboarding_state")
