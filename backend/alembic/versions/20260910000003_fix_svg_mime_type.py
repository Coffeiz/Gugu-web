"""修正 create_file 落库的 svg MIME：text/plain → image/svg+xml。

create_file 曾把 svg 强制按 text/plain 落库（1c76c3371），导致缩略图与图片
预览端点按 MIME 白名单返回 415。read/edit 按扩展名白名单（TEXT_EXTS 含 svg）
判定文本，不依赖该 MIME，因此历史行可以安全回填。
"""
from alembic import op


revision = "20260910000003"
down_revision = "20260910000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE files SET mime_type = 'image/svg+xml' "
        "WHERE lower(ext) = 'svg' AND (mime_type IS NULL OR mime_type = 'text/plain')"
    )


def downgrade() -> None:
    # 不回滚数据：历史 svg 行回填 image/svg+xml 是纠错，降级保持现状。
    pass
