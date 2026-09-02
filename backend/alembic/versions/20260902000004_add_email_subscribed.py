"""为用户增加产品更新邮件订阅开关。"""
from alembic import op
import sqlalchemy as sa

revision = "20260902000004"
down_revision = "20260902000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("users"):
        return
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "email_subscribed" not in columns:
        op.add_column("users", sa.Column("email_subscribed", sa.Boolean(), nullable=False, server_default=sa.false()))
        op.create_index("ix_users_email_subscribed", "users", ["email_subscribed"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("users"):
        return
    columns = {column["name"] for column in inspector.get_columns("users")}
    if "email_subscribed" in columns:
        indexes = {index["name"] for index in inspector.get_indexes("users")}
        if "ix_users_email_subscribed" in indexes:
            op.drop_index("ix_users_email_subscribed", table_name="users")
        op.drop_column("users", "email_subscribed")
