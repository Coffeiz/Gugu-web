"""补正已应用早期平行关系迁移的开发库

Revision ID: 20260713000002
Revises: 20260713000001
Create Date: 2026-07-13

20260713000001 在开发库首次执行后才收敛为 edge_key 方案。本迁移幂等地补齐列与最终唯一
约束；新环境已具备该结构时仅重建同名约束，不会改变数据。
"""
import sqlalchemy as sa
from alembic import op


revision = "20260713000002"
down_revision = "20260713000001"
branch_labels = None
depends_on = None


def _has_edge_key() -> bool:
    columns = sa.inspect(op.get_bind()).get_columns("mind_relations")
    return any(column["name"] == "edge_key" for column in columns)


def _has_relation_unique() -> bool:
    constraints = sa.inspect(op.get_bind()).get_unique_constraints("mind_relations")
    return any(constraint["name"] == "uq_mind_relation" for constraint in constraints)


def upgrade():
    if not _has_edge_key():
        op.add_column(
            "mind_relations",
            sa.Column("edge_key", sa.String(length=32), nullable=False, server_default=""),
        )
    if _has_relation_unique():
        op.drop_constraint("uq_mind_relation", "mind_relations", type_="unique")
    op.create_unique_constraint(
        "uq_mind_relation",
        "mind_relations",
        ["user_id", "src_node_id", "dst_node_id", "rel_type", "edge_key"],
    )


def downgrade():
    op.drop_constraint("uq_mind_relation", "mind_relations", type_="unique")
    op.create_unique_constraint(
        "uq_mind_relation",
        "mind_relations",
        ["user_id", "src_node_id", "dst_node_id", "rel_type", "edge_key"],
    )
