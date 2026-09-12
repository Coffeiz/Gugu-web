"""knowledge_index_entries 增量同步水位索引

PRD-RAG-9 索引生命周期移交 TS：worker 以 (owner, source, indexed_at > 水位)
增量读取变更行（含软删墓碑行）。现有索引不支持该谓词，会退化为 owner 全表扫。

Revision: 20260913000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20260913000001"
down_revision = "20260912000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_knowledge_index_owner_source_indexed",
        "knowledge_index_entries",
        ["owner_user_id", "source_type", "indexed_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_index_owner_source_indexed", "knowledge_index_entries")
