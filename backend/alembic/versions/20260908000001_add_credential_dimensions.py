"""user_provider_credentials 增加 dimensions 列（BYOK Embedding 凭据）。

embedding 模型的请求维度（0/NULL=用模型默认）；llm 等其他能力不读该列。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260908000001"
down_revision = "20260907000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_provider_credentials",
        sa.Column("dimensions", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_provider_credentials", "dimensions")
