"""为项目卡片增加事务一致的文件数投影。

Revision ID: 20261015000001
Revises: 20261014000002
Create Date: 2026-10-15
"""
from alembic import op

from app.db.project_file_counts import PROJECT_FILE_COUNT_PROJECTION_SQL, PROJECT_FILE_COUNT_DROP_SQL


revision = "20261015000001"
down_revision = "20261014000002"
branch_labels = None
depends_on = None
bootstrap_on_empty_database = True
bootstrap_on_legacy_database = True


def upgrade() -> None:
    for sql in PROJECT_FILE_COUNT_PROJECTION_SQL:
        op.execute(sql)


def downgrade() -> None:
    for sql in PROJECT_FILE_COUNT_DROP_SQL:
        op.execute(sql)
