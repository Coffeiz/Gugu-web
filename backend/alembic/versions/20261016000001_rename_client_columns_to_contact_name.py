"""将项目和日历活动中的自由文本联系人字段改名为联系人。

Revision ID: 20261016000001
Revises: 20261015000001
Create Date: 2026-10-16
"""
from alembic import op
import sqlalchemy as sa


revision = "20261016000001"
down_revision = "20261015000001"
branch_labels = None
depends_on = None
# 新库由当前 ORM metadata 直接创建 contact_name；只有无版本表的旧库需要执行此重命名。
bootstrap_on_legacy_database = True


def _rename_column(table: str, source: str, target: str) -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}
    if source in columns and target in columns:
        raise RuntimeError(f"{table} 同时存在 {source} 和 {target}，拒绝猜测数据迁移方向")
    if target in columns:
        return
    if source not in columns:
        raise RuntimeError(f"{table} 缺少预期列 {source} 和 {target}")
    op.alter_column(
        table, source, new_column_name=target,
        existing_type=sa.String(length=200), existing_nullable=True,
    )


def upgrade() -> None:
    _rename_column("projects", "client", "contact_name")
    _rename_column("calendar_events", "client", "contact_name")


def downgrade() -> None:
    _rename_column("calendar_events", "contact_name", "client")
    _rename_column("projects", "contact_name", "client")
