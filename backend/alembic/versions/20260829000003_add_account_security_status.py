"""增加统一账户风险状态字段。"""

from alembic import op
import sqlalchemy as sa


revision = "20260829000003"
down_revision = "20260829000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "account_status" not in columns:
        op.add_column("users", sa.Column("account_status", sa.String(length=16), nullable=False, server_default="active"))
    if "suspended_until" not in columns:
        op.add_column("users", sa.Column("suspended_until", sa.DateTime(timezone=True), nullable=True))
    if "suspended_reason" not in columns:
        op.add_column("users", sa.Column("suspended_reason", sa.String(length=200), nullable=True))
    if "security_version" not in columns:
        op.add_column("users", sa.Column("security_version", sa.Integer(), nullable=False, server_default="1"))
    if "ix_users_account_status" not in {item["name"] for item in inspector.get_indexes("users")}:
        op.create_index("ix_users_account_status", "users", ["account_status"])


def downgrade() -> None:
    op.drop_index("ix_users_account_status", table_name="users")
    op.drop_column("users", "security_version")
    op.drop_column("users", "suspended_reason")
    op.drop_column("users", "suspended_until")
    op.drop_column("users", "account_status")
