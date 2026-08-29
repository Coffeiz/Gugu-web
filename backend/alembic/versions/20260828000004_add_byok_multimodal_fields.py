"""为用户模型配置增加多模态能力字段。"""

from alembic import op
import sqlalchemy as sa


revision = "20260828000004"
down_revision = "20260828000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("user_provider_credentials"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_provider_credentials")}
    fields = (
        ("vision", sa.Boolean(), sa.false()),
        ("vision_video", sa.Boolean(), sa.false()),
        ("vision_audio", sa.Boolean(), sa.false()),
        ("vision_detail", sa.String(length=16), "auto"),
    )
    for name, column_type, default in fields:
        if name not in columns:
            op.add_column("user_provider_credentials", sa.Column(name, column_type, nullable=False, server_default=default))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("user_provider_credentials"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_provider_credentials")}
    for name in ("vision_detail", "vision_audio", "vision_video", "vision"):
        if name in columns:
            op.drop_column("user_provider_credentials", name)
