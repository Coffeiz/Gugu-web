"""思维画布允许同一节点对的平行关系边

Revision ID: 20260713000001
Revises: 20260711000003
Create Date: 2026-07-13

related 默认仍由服务层幂等；这里只移除数据库层的节点对唯一约束，让画布在明确请求时能够
创建第二条独立边，分别保存左右端点以绘制 loop。
"""
from alembic import op
import sqlalchemy as sa


revision = "20260713000001"
down_revision = "20260711000003"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("uq_mind_relation", "mind_relations", type_="unique")
    op.add_column(
        "mind_relations",
        sa.Column("edge_key", sa.String(length=32), nullable=False, server_default=""),
    )
    op.create_unique_constraint(
        "uq_mind_relation",
        "mind_relations",
        ["user_id", "src_node_id", "dst_node_id", "rel_type", "edge_key"],
    )


def downgrade():
    op.drop_constraint("uq_mind_relation", "mind_relations", type_="unique")
    op.drop_column("mind_relations", "edge_key")
    op.create_unique_constraint(
        "uq_mind_relation",
        "mind_relations",
        ["user_id", "src_node_id", "dst_node_id", "rel_type"],
    )
