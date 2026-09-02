"""增加用户自定义 SMTP 配置。"""
from alembic import op
import sqlalchemy as sa

revision = "20260902000001"
down_revision = "20260831000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("user_smtp_configs"):
        return
    op.create_table(
        "user_smtp_configs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("host", sa.String(length=255), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False, server_default="587"),
        sa.Column("user", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("password", sa.Text(), nullable=False, server_default=""),
        sa.Column("from_addr", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("use_ssl", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"), sa.UniqueConstraint("user_id"),
    )
    op.create_index("ix_user_smtp_configs_user_id", "user_smtp_configs", ["user_id"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("user_smtp_configs"):
        op.drop_index("ix_user_smtp_configs_user_id", table_name="user_smtp_configs")
        op.drop_table("user_smtp_configs")
