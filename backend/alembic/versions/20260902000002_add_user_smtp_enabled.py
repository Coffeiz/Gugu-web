"""为用户 SMTP 配置增加显式启用开关。"""
from alembic import op
import sqlalchemy as sa

revision = "20260902000002"
down_revision = "20260902000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("user_smtp_configs"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_smtp_configs")}
    if "enabled" not in columns:
        op.add_column("user_smtp_configs", sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("user_smtp_configs") and "enabled" in {column["name"] for column in inspector.get_columns("user_smtp_configs")}:
        op.drop_column("user_smtp_configs", "enabled")
