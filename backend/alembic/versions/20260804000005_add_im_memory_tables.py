"""新增 IM 群组/member 记忆的任务、游标和来源索引表。"""

from alembic import op


revision = "20260804000005"
down_revision = "20260804000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS memory_reflection_jobs (
        id SERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(20) NOT NULL,
        bot_id VARCHAR(128) NOT NULL,
        scope_type VARCHAR(32) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        from_message_id INTEGER NULL,
        to_message_id INTEGER NULL,
        idempotency_key VARCHAR(300) NOT NULL UNIQUE,
        extractor_version VARCHAR(64) NOT NULL DEFAULT 'im-memory-v1',
        reason VARCHAR(32) NOT NULL DEFAULT 'idle',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        locked_at TIMESTAMPTZ NULL,
        last_error_code VARCHAR(100) NULL,
        dead_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_memory_reflection_range UNIQUE
          (owner_user_id, platform, bot_id, scope_type, scope_id,
           from_message_id, to_message_id, extractor_version)
    )
    """)
    op.execute("""
    CREATE TABLE IF NOT EXISTS memory_reflection_cursors (
        id SERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(20) NOT NULL,
        bot_id VARCHAR(128) NOT NULL,
        scope_type VARCHAR(32) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        last_message_id INTEGER NULL,
        last_reflected_message_id INTEGER NULL,
        last_message_at TIMESTAMPTZ NULL,
        active_started_at TIMESTAMPTZ NULL,
        settled_at TIMESTAMPTZ NULL,
        scope_version INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_memory_reflection_cursor_scope UNIQUE
          (owner_user_id, platform, bot_id, scope_type, scope_id)
    )
    """)
    op.execute("""
    CREATE TABLE IF NOT EXISTS memory_entries (
        id SERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(20) NOT NULL,
        bot_id VARCHAR(128) NOT NULL,
        scope_type VARCHAR(32) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        entry_key VARCHAR(255) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        content_hash VARCHAR(128) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_memory_entry_scope_key UNIQUE
          (owner_user_id, platform, bot_id, scope_type, scope_id, entry_key)
    )
    """)
    op.execute("""
    CREATE TABLE IF NOT EXISTS memory_sources (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_memory_source_entry_message UNIQUE (entry_id, message_id)
    )
    """)
    for statement in (
        "CREATE INDEX IF NOT EXISTS ix_memory_reflection_jobs_scope ON memory_reflection_jobs (owner_user_id, platform, bot_id, scope_type, scope_id)",
        "CREATE INDEX IF NOT EXISTS ix_memory_reflection_jobs_due ON memory_reflection_jobs (status, next_attempt_at)",
        "CREATE INDEX IF NOT EXISTS ix_memory_reflection_cursors_last_message ON memory_reflection_cursors (last_message_at)",
        "CREATE INDEX IF NOT EXISTS ix_memory_entries_scope ON memory_entries (owner_user_id, platform, bot_id, scope_type, scope_id)",
    ):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS memory_sources")
    op.execute("DROP TABLE IF EXISTS memory_entries")
    op.execute("DROP TABLE IF EXISTS memory_reflection_cursors")
    op.execute("DROP TABLE IF EXISTS memory_reflection_jobs")
