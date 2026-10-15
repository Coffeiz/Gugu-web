"""将 QQ 私聊流式行为并入消息格式设置。"""
from alembic import op
import sqlalchemy as sa


revision = "20261014000002"
down_revision = "20261014000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    user_bots = sa.table(
        "user_bots",
        sa.column("private_streaming_enabled", sa.Boolean()),
        sa.column("private_message_format", sa.String(length=16)),
    )
    # Preserve the effective Markdown behavior for bots that used the old switch.
    op.execute(
        user_bots.update()
        .where(user_bots.c.private_streaming_enabled.is_(True))
        .values(private_message_format="markdown")
    )
    with op.batch_alter_table("user_bots") as batch:
        batch.drop_column("private_streaming_enabled")


def downgrade() -> None:
    # The former per-bot switch cannot be reconstructed after its behavior is
    # folded into private_message_format. Restore it disabled for compatibility.
    with op.batch_alter_table("user_bots") as batch:
        batch.add_column(
            sa.Column(
                "private_streaming_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
