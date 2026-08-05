"""为 IM memory scope 增加删除屏障。"""

from alembic import op


revision = "20260804000006"
down_revision = "20260804000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS memory_scope_tombstones (
        id SERIAL PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform VARCHAR(20) NOT NULL,
        bot_id VARCHAR(128) NOT NULL,
        scope_type VARCHAR(32) NOT NULL,
        scope_id VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        delete_version INTEGER NOT NULL DEFAULT 1,
        reason VARCHAR(100) NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT uq_memory_scope_tombstone_scope
          UNIQUE (owner_user_id, platform, bot_id, scope_type, scope_id)
    )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_memory_scope_tombstones_status "
        "ON memory_scope_tombstones (status, updated_at)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS memory_scope_tombstones")
