"""将画布关系隔离到具体画布。

旧版本关系没有画布归属：能唯一匹配到一张画布的历史关系迁移到该画布，
跨多张画布或没有画布的关系保留为 legacy 全局关系，但不再被画布接口读取。
"""
import sqlalchemy as sa
from alembic import op


revision = "20260831000002"
down_revision = "20260831000001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "mind_relations",
        sa.Column("canvas_id", sa.Integer(), sa.ForeignKey("mind_maps.id", ondelete="CASCADE"), nullable=True),
    )
    op.create_index("ix_mind_relations_canvas_id", "mind_relations", ["canvas_id"])
    op.drop_constraint("uq_mind_relation", "mind_relations", type_="unique")
    op.create_unique_constraint(
        "uq_mind_relation",
        "mind_relations",
        ["user_id", "canvas_id", "src_node_id", "dst_node_id", "rel_type", "edge_key"],
    )
    op.create_index(
        "uq_mind_relation_legacy",
        "mind_relations",
        ["user_id", "src_node_id", "dst_node_id", "rel_type", "edge_key"],
        unique=True,
        postgresql_where=sa.text("canvas_id IS NULL"),
        sqlite_where=sa.text("canvas_id IS NULL"),
    )

    # 只有关系两端共同出现在唯一一张画布时才自动迁移，避免把历史关系猜错归属。
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        """
        SELECT r.id, MIN(ci1.canvas_id) AS canvas_id
        FROM mind_relations r
        JOIN mind_canvas_items ci1 ON ci1.node_id = r.src_node_id AND ci1.user_id = r.user_id
        JOIN mind_canvas_items ci2 ON ci2.node_id = r.dst_node_id
            AND ci2.canvas_id = ci1.canvas_id AND ci2.user_id = r.user_id
        GROUP BY r.id
        HAVING COUNT(DISTINCT ci1.canvas_id) = 1
        """
    )).fetchall()
    for relation_id, canvas_id in rows:
        bind.execute(
            sa.text("UPDATE mind_relations SET canvas_id = :canvas_id WHERE id = :relation_id"),
            {"canvas_id": canvas_id, "relation_id": relation_id},
        )


def downgrade():
    raise NotImplementedError(
        "该迁移不可逆：多个画布可能已经存在相同关系，无法安全恢复旧的全局唯一约束"
    )
