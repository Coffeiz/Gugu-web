"""新增 video_cache_snapshots 表（PRD-STORAGE-1 Phase B 存储占用趋势面板）。

video_cache_gc 每次跑完清理后落一条快照，管理后台画趋势图。
"""

from alembic import op


revision = "20260809000002"
down_revision = "20260809000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE IF NOT EXISTS video_cache_snapshots (
        id SERIAL PRIMARY KEY,
        taken_at TIMESTAMPTZ NOT NULL,
        object_count INTEGER NOT NULL DEFAULT 0,
        total_bytes BIGINT NOT NULL DEFAULT 0
    )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_video_cache_snapshots_taken_at "
        "ON video_cache_snapshots (taken_at)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS video_cache_snapshots")
