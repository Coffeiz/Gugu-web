"""将生成失败和中断状态与 canonical 对话正文分离持久化。

Revision ID: 20261004000003
Revises: 20261004000002
Create Date: 2026-10-04
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261004000003"
down_revision = "20261004000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column("run_outcome", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_messages", "run_outcome")
