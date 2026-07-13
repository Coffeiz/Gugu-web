"""思维面板 P0 地基：mind_nodes / mind_canvas_items / mind_relations

Revision ID: 20260710000002
Revises: 20260710000001
Create Date: 2026-07-10

三层结构见 docs/product/思维面板/数据模型草案.md：节点全局、画布只是视图、关系挂在节点之间。

幂等：建表前先探 has_table——这些表可能已被 Base.metadata.create_all 建过（见 deploy.md §10.2），
重复 create_table 会直接报错。
"""
import sqlalchemy as sa
from alembic import op

revision = '20260710000002'
down_revision = '20260710000001'
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade():
    if not _has_table("mind_nodes"):
        op.create_table(
            "mind_nodes",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False, server_default="note"),
            sa.Column("title", sa.String(300), nullable=True),
            sa.Column("content_md", sa.Text(), nullable=False, server_default=""),
            sa.Column("content_plain", sa.Text(), nullable=False, server_default=""),
            sa.Column("color", sa.String(30), nullable=True),
            sa.Column("ref_type", sa.String(20), nullable=True),
            # ref_id 故意不是外键：业务对象被删时不连带删节点，留墓碑
            sa.Column("ref_id", sa.Integer(), nullable=True),
            sa.Column("origin", sa.String(10), nullable=False, server_default="user"),
            sa.Column("indexed_at", sa.DateTime(), nullable=True),
            sa.Column("indexed_hash", sa.String(64), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("captured_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("deleted_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("user_id", "ref_type", "ref_id", name="uq_mind_node_ref"),
            sa.CheckConstraint(
                "(kind = 'ref' AND ref_type IS NOT NULL AND ref_id IS NOT NULL) "
                "OR (kind <> 'ref' AND ref_type IS NULL AND ref_id IS NULL)",
                name="ck_mind_node_ref_shape",
            ),
        )
        op.create_index("ix_mind_nodes_user_id", "mind_nodes", ["user_id"])
        op.create_index("ix_mind_nodes_captured_at", "mind_nodes", ["captured_at"])
        op.create_index("ix_mind_nodes_deleted_at", "mind_nodes", ["deleted_at"])

    if not _has_table("mind_canvas_items"):
        op.create_table(
            "mind_canvas_items",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("canvas_id", sa.Integer(), sa.ForeignKey("mind_maps.id", ondelete="CASCADE"), nullable=False),
            sa.Column("node_id", sa.Integer(), sa.ForeignKey("mind_nodes.id", ondelete="CASCADE"), nullable=False),
            sa.Column("x", sa.Float(), nullable=False, server_default="0"),
            sa.Column("y", sa.Float(), nullable=False, server_default="0"),
            sa.Column("w", sa.Float(), nullable=True),
            sa.Column("h", sa.Float(), nullable=True),
            sa.Column("z", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("collapsed", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("data_json", sa.Text(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("canvas_id", "node_id", name="uq_canvas_node"),
        )
        op.create_index("ix_mind_canvas_items_user_id", "mind_canvas_items", ["user_id"])
        op.create_index("ix_mind_canvas_items_canvas_id", "mind_canvas_items", ["canvas_id"])
        op.create_index("ix_mind_canvas_items_node_id", "mind_canvas_items", ["node_id"])

    if not _has_table("mind_relations"):
        op.create_table(
            "mind_relations",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("src_node_id", sa.Integer(), sa.ForeignKey("mind_nodes.id", ondelete="CASCADE"), nullable=False),
            sa.Column("dst_node_id", sa.Integer(), sa.ForeignKey("mind_nodes.id", ondelete="CASCADE"), nullable=False),
            sa.Column("rel_type", sa.String(20), nullable=False, server_default="related"),
            sa.Column("origin", sa.String(10), nullable=False, server_default="user"),
            sa.Column("status", sa.String(10), nullable=False, server_default="confirmed"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("user_id", "src_node_id", "dst_node_id", "rel_type", name="uq_mind_relation"),
            sa.CheckConstraint("src_node_id <> dst_node_id", name="ck_mind_relation_no_self"),
        )
        op.create_index("ix_mind_relations_user_id", "mind_relations", ["user_id"])
        op.create_index("ix_mind_relations_src_node_id", "mind_relations", ["src_node_id"])
        op.create_index("ix_mind_relations_dst_node_id", "mind_relations", ["dst_node_id"])


def downgrade():
    # 反建表顺序：先删引用 mind_nodes 的两张，再删 mind_nodes
    op.execute("DROP TABLE IF EXISTS mind_relations")
    op.execute("DROP TABLE IF EXISTS mind_canvas_items")
    op.execute("DROP TABLE IF EXISTS mind_nodes")
