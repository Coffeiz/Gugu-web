"""把 video_cache_snapshots 泛化成通用的 storage_category_snapshots 表
（PRD-STORAGE-2 存储监控面板）——不用每加一个监控类别就建一张新表。

video_cache_snapshots 落地不到一天，还没有真实积累的数据（下一次定时任务
凌晨才跑第一次），直接删表重建，不做数据迁移。
"""

from alembic import op


revision = "20260809000003"
down_revision = "20260809000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS video_cache_snapshots")
    op.execute("""
    CREATE TABLE IF NOT EXISTS storage_category_snapshots (
        id SERIAL PRIMARY KEY,
        category VARCHAR(64) NOT NULL,
        taken_at TIMESTAMPTZ NOT NULL,
        object_count INTEGER NOT NULL DEFAULT 0,
        total_bytes BIGINT NOT NULL DEFAULT 0
    )
    """)
    for statement in (
        "CREATE INDEX IF NOT EXISTS ix_storage_category_snapshots_category "
        "ON storage_category_snapshots (category)",
        "CREATE INDEX IF NOT EXISTS ix_storage_category_snapshots_taken_at "
        "ON storage_category_snapshots (taken_at)",
    ):
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS storage_category_snapshots")
    op.execute("""
    CREATE TABLE IF NOT EXISTS video_cache_snapshots (
        id SERIAL PRIMARY KEY,
        taken_at TIMESTAMPTZ NOT NULL,
        object_count INTEGER NOT NULL DEFAULT 0,
        total_bytes BIGINT NOT NULL DEFAULT 0
    )
    """)
