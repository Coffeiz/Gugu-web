"""为文件与文件夹名添加可增量维护的拼音搜索别名。

Revision ID: 20261012000002
Revises: 20261012000001
Create Date: 2026-10-12
"""
from alembic import op


revision = "20261012000002"
down_revision = "20261012000001"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE files ADD COLUMN IF NOT EXISTS search_romaji TEXT NULL")
    op.execute("ALTER TABLE folders ADD COLUMN IF NOT EXISTS search_romaji TEXT NULL")
    op.execute("""
        CREATE TABLE IF NOT EXISTS global_search_backfill_state (
            name VARCHAR(100) PRIMARY KEY,
            completed_at TIMESTAMPTZ NULL
        )
    """)
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_search_files_romaji_trgm "
        "ON files USING gin (search_romaji gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_search_folders_romaji_trgm "
        "ON folders USING gin (search_romaji gin_trgm_ops)"
    )


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_search_folders_romaji_trgm")
    op.execute("DROP INDEX IF EXISTS ix_search_files_romaji_trgm")
    op.execute("DROP TABLE IF EXISTS global_search_backfill_state")
    op.execute("ALTER TABLE folders DROP COLUMN IF EXISTS search_romaji")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS search_romaji")
