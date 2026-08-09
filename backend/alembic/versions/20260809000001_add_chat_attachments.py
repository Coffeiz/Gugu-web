"""新增 chat_attachments 表（PRD-STORAGE-1 Phase A：附件所有权状态机）。

DB 是所有权真相来源，state 只有 draft/attached 两态；storage_key 允许被多条
行共享（PRD-IM-9 引用复用场景），不加唯一约束。CHECK 约束把 state/message_id
的对应关系压进 DB 层：draft 必须 message_id 为空，attached 必须不为空。
"""

from alembic import op


revision = "20260809000001"
down_revision = "20260807000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS chat_attachments (
        id SERIAL PRIMARY KEY,
        attach_id VARCHAR(32) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        storage_key VARCHAR(500) NOT NULL,
        name VARCHAR(300) NOT NULL DEFAULT '',
        ext VARCHAR(20) NOT NULL DEFAULT '',
        mime VARCHAR(200) NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'binary',
        size BIGINT NOT NULL DEFAULT 0,
        duration DOUBLE PRECISION NULL,
        img_width INTEGER NULL,
        img_height INTEGER NULL,
        state VARCHAR(10) NOT NULL DEFAULT 'draft',
        extra JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL,
        attached_at TIMESTAMPTZ NULL,
        CONSTRAINT uq_chat_attachments_user_attach UNIQUE (user_id, attach_id),
        CONSTRAINT ck_chat_attachments_state_message CHECK (
            (state = 'draft' AND message_id IS NULL) OR
            (state = 'attached' AND message_id IS NOT NULL)
        )
    )
    """)
    for statement in (
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_attach_id ON chat_attachments (attach_id)",
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_user_id ON chat_attachments (user_id)",
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_state_created ON chat_attachments (state, created_at)",
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_user_storage ON chat_attachments (user_id, storage_key)",
        "CREATE INDEX IF NOT EXISTS ix_chat_attachments_message ON chat_attachments (message_id)",
    ):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS chat_attachments")
