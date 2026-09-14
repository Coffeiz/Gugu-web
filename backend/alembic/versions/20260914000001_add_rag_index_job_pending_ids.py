"""rag_index_jobs 增加同源待处理文档 ID 集合

PRD-RAG-9 §5.2/Phase 5：同源多文档事件合并不得丢弃 source_id。
pending_source_ids 记录所有待处理文档 ID（JSON 数组）；来源级事件清空集合。

Revision: 20260914000001
"""
from alembic import op
import sqlalchemy as sa


revision = "20260914000001"
down_revision = "20260913000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rag_index_jobs",
        sa.Column("pending_source_ids", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rag_index_jobs", "pending_source_ids")
