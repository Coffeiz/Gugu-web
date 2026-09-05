"""把推理状态持久化策略从用户偏好迁移到模型配置。"""
from alembic import op
import sqlalchemy as sa


revision = "llm23_phase3_model_policy"
down_revision = "llm23_phase1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_provider_credentials",
        sa.Column("reasoning_persistence", sa.String(length=20), server_default="off", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("user_provider_credentials", "reasoning_persistence")
