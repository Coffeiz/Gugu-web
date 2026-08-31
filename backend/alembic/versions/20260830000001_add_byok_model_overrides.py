"""增加用户 BYOK 的模型行为覆盖字段。"""

from alembic import op
import sqlalchemy as sa


revision = "20260830000001"
down_revision = "20260829000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("user_provider_credentials"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_provider_credentials")}
    fields = (
        ("max_tokens", sa.Integer()),
        ("context_tokens", sa.Integer()),
        ("thinking", sa.String(length=16)),
        ("reasoning_effort", sa.String(length=16)),
    )
    for name, column_type in fields:
        if name not in columns:
            op.add_column("user_provider_credentials", sa.Column(name, column_type, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("user_provider_credentials"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_provider_credentials")}
    for name in ("reasoning_effort", "thinking", "context_tokens", "max_tokens"):
        if name in columns:
            op.drop_column("user_provider_credentials", name)
