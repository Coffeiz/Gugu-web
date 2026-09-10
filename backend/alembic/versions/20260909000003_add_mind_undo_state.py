"""为思维画布增加可恢复软删除状态。"""
from alembic import op
import sqlalchemy as sa


revision = "20260909000003"
down_revision = "20260909000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("mind_maps", "mind_canvas_items", "mind_relations"):
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
        op.create_index(f"ix_{table}_deleted_at", table, ["deleted_at"])


def downgrade() -> None:
    for table in ("mind_relations", "mind_canvas_items", "mind_maps"):
        op.drop_index(f"ix_{table}_deleted_at", table_name=table)
        op.drop_column(table, "deleted_at")
