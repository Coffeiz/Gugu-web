"""删除已由 user_bots 体系取代的旧平台绑定表。"""

from alembic import op
import sqlalchemy as sa


revision = "20260821000003"
down_revision = "20260821000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # BYO bot 接入后，机器人归属直接由 user_bots.user_id 表达；当前代码不再读写
    # platform_bindings。使用 IF EXISTS 兼容已经被手工清理过的开发库。
    op.execute("DROP TABLE IF EXISTS platform_bindings")


def downgrade() -> None:
    op.create_table(
        "platform_bindings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("platform", sa.String(length=20)),
        sa.Column("platform_user_id", sa.String(length=128)),
        sa.Column("channel_id", sa.String(length=64)),
        sa.Column("display_name", sa.String(length=100)),
        sa.Column("created_at", sa.DateTime()),
        sa.UniqueConstraint("platform", "platform_user_id", name="uq_platform_user"),
    )
    op.create_index("ix_platform_bindings_user_id", "platform_bindings", ["user_id"])
    op.create_index(
        "ix_platform_bindings_platform_user_id",
        "platform_bindings",
        ["platform_user_id"],
    )
