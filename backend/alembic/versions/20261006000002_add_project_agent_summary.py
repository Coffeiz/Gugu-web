"""Add Agent-maintained project summary."""

from alembic import op
import sqlalchemy as sa


revision = "20261006000002"
down_revision = "20261006000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("projects")}
    if "summary" not in columns:
        op.add_column("projects", sa.Column("summary", sa.String(length=200), nullable=True))


def downgrade() -> None:
    # 不自动删除已被咕咕维护的项目摘要。
    pass
