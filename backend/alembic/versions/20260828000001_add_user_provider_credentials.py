"""增加用户 BYOK 凭据表。"""

from alembic import op
import sqlalchemy as sa


revision = "20260828000001"
down_revision = "20260827000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("user_provider_credentials"):
        return
    op.create_table(
        "user_provider_credentials",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("api_format", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("capability", sa.String(length=32), nullable=False),
        sa.Column("encrypted_value", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("encrypted_data_key", sa.Text(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("base_url", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("vision", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("vision_video", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("vision_audio", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("vision_detail", sa.String(length=16), nullable=False, server_default="auto"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_provider_credentials_user_id", "user_provider_credentials", ["user_id"])
    op.create_index("ix_user_provider_credentials_capability", "user_provider_credentials", ["capability"])
    op.create_index("ix_user_provider_credentials_enabled", "user_provider_credentials", ["enabled"])


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("user_provider_credentials"):
        return
    op.drop_index("ix_user_provider_credentials_enabled", table_name="user_provider_credentials")
    op.drop_index("ix_user_provider_credentials_capability", table_name="user_provider_credentials")
    op.drop_index("ix_user_provider_credentials_user_id", table_name="user_provider_credentials")
    op.drop_table("user_provider_credentials")
