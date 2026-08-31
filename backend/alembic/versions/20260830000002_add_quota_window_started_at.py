"""增加用户级 6 小时配额窗口起点。"""

from alembic import op
import sqlalchemy as sa


revision = "20260830000002"
down_revision = "20260830000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "quota_window_started_at" not in columns:
        op.add_column("users", sa.Column("quota_window_started_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "quota_window_started_at" in columns:
        op.drop_column("users", "quota_window_started_at")
