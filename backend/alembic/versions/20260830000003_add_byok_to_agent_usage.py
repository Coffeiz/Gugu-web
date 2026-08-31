"""标记用户 BYOK 用量，避免计入咕咕精力。"""

from alembic import op
import sqlalchemy as sa


revision = "20260830000003"
down_revision = "20260830000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("agent_usage")}
    if "is_byok" not in columns:
        op.add_column("agent_usage", sa.Column("is_byok", sa.Boolean(), nullable=False, server_default=sa.false()))
        op.create_index("ix_agent_usage_is_byok", "agent_usage", ["is_byok"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("agent_usage")}
    if "is_byok" in columns:
        op.drop_index("ix_agent_usage_is_byok", table_name="agent_usage")
        op.drop_column("agent_usage", "is_byok")
