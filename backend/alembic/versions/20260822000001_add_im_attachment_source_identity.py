"""为 IM 附件增加平台消息来源标识，支持引用附件复用。"""

from alembic import op


revision = "20260822000001"
down_revision = "20260821000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS platform VARCHAR(20)")
    op.execute("ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS platform_message_id VARCHAR(255)")
    op.execute("ALTER TABLE chat_attachments ADD COLUMN IF NOT EXISTS attachment_index INTEGER")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_platform_message "
        "ON chat_attachments (user_id, platform, platform_message_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_chat_attachments_platform_message")
    op.execute("ALTER TABLE chat_attachments DROP COLUMN IF EXISTS attachment_index")
    op.execute("ALTER TABLE chat_attachments DROP COLUMN IF EXISTS platform_message_id")
    op.execute("ALTER TABLE chat_attachments DROP COLUMN IF EXISTS platform")
