"""add storage P2 fields: File.storage_backend/version, Folder.version/updated_at/deleted_at

Revision ID: 20260714000001
Revises: 20260713000002
Create Date: 2026-07-14

见 docs/refactor/文件存储架构方案.md §6/§7 P2.1。全部 NOT NULL + server_default（同
20260622000002 给 projects/calendar_events 加 version 的先例）——Postgres 加带
server_default 的列走 metadata-only 变更，不锁表/不回填，存量行读到 default 值，
零行为变化、零迁移风险。

- File.storage_backend：现在全部是 'local'；给「需求突增直接切 OSS」留好快速通道，
  不建任何 OSS 系统，加列 ≠ 建系统。
- File.version：延伸现有的乐观并发模式（Project/CalendarEvent 已用，见
  app/core/projects.py::update_project_atomic）到文件，供未来文件级并发编辑用。
- Folder.version/updated_at/deleted_at：P2.2 软删 + P2.6 乐观并发的前置字段。
  Folder 目前完全没有 updated_at，一并补上（改名/移动/软删都要用它）。
"""
import sqlalchemy as sa
from alembic import op

revision = "20260714000001"
down_revision = "20260713000002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("files", sa.Column("storage_backend", sa.String(length=20), nullable=False, server_default="local"))
    op.add_column("files", sa.Column("version", sa.Integer(), nullable=False, server_default="1"))

    op.add_column("folders", sa.Column("version", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("folders", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                                       server_default=sa.text("now()")))
    op.add_column("folders", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_folders_deleted_at", "folders", ["deleted_at"])


def downgrade():
    op.drop_index("ix_folders_deleted_at", table_name="folders")
    op.drop_column("folders", "deleted_at")
    op.drop_column("folders", "updated_at")
    op.drop_column("folders", "version")

    op.drop_column("files", "version")
    op.drop_column("files", "storage_backend")
