"""区分用户管理与咕咕管理的 Prompt Skill。

Revision ID: 20261009000002
Revises: 20261009000001
Create Date: 2026-10-09
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261009000002"
down_revision = "20261009000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 历史 Skill 都由用户显式创建或维护，迁移后继续由用户管理。
    op.add_column(
        "user_skills",
        sa.Column("managed_by", sa.String(length=16), nullable=False, server_default="user"),
    )
    op.execute("UPDATE user_skills SET managed_by = 'user'")


def downgrade() -> None:
    op.drop_column("user_skills", "managed_by")
