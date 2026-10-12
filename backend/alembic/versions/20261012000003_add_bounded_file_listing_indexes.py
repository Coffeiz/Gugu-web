"""为文件库默认创建时间 keyset 分页建立有界读取索引。

Revision ID: 20261012000003
Revises: 20261012000002
Create Date: 2026-10-12
"""
from alembic import op


revision = "20261012000003"
down_revision = "20261012000002"
branch_labels = None
depends_on = None
bootstrap_on_empty_database = True


_INDEXES = (
    ("ix_files_trash_page", "files",
     "(user_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL"),
    ("ix_folders_trash_page", "folders",
     "(user_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL"),
    ("ix_files_trash_folder_page", "files",
     "(user_id, folder_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL"),
    ("ix_folders_trash_child_page", "folders",
     "(user_id, parent_id, deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL"),
)

_TYPE_GROUP_SQL = "CASE " + " ".join(
    f"WHEN ext IN ({','.join(repr(ext) for ext in exts)}) THEN {category!r}"
    for category, exts in (
        ("image", ("JPG", "JPEG", "PNG", "GIF", "WEBP", "SVG", "ICO", "BMP", "AVIF", "HEIC", "HEIF", "TIF", "TIFF")),
        ("video", ("MP4", "MOV", "AVI", "MKV", "WEBM", "WMV", "FLV", "M4V")),
        ("audio", ("MP3", "WAV", "FLAC", "AAC", "OGG", "M4A", "WMA", "OPUS")),
        ("sheet", ("XLS", "XLSX", "CSV", "ODS", "NUMBERS")),
        ("slide", ("PPT", "PPTX", "KEY", "ODP")),
        ("archive", ("ZIP", "RAR", "7Z", "TAR", "GZ", "BZ2", "XZ")),
        ("code", ("JS", "TS", "JSX", "TSX", "VUE", "PY", "GO", "RS", "JAVA", "CPP", "C", "CS", "RB", "SWIFT", "PHP", "KT", "DART", "SH", "HTML", "CSS", "SCSS", "LESS", "XML", "JSON", "YAML", "YML", "TOML", "MD", "MDX", "GRAPHQL")),
    )
) + " ELSE 'doc' END || ':' || lower(ext)"

_FILE_SORT_EXPRESSIONS = (
    ("name", 'display_name COLLATE "gugu_natural_zh"'),
    ("type", f"({_TYPE_GROUP_SQL})"),
    ("stage", 'stage_name COLLATE "gugu_natural_zh"'),
    ("created", "created_at DESC, id DESC"),
    ("size", "size_bytes"),
    ("id", "id"),
)
_FILES_PAGE_INDEXES = tuple(
    (
        f"ix_files_page_{sort_name}_scope",
        "files",
        "(user_id, space, "
        "coalesce(project_id, workspace_directory_id, mind_map_id, 0), "
        f"coalesce(folder_id, 0), {sort_expression}"
        f"{'' if sort_name in {'created', 'id'} else ', id'}) WHERE deleted_at IS NULL",
    )
    for sort_name, sort_expression in _FILE_SORT_EXPRESSIONS
)
_FOLDERS_PAGE_INDEXES = (
    ("ix_folders_page_name_scope", "folders",
     '(user_id, coalesce(project_id, workspace_directory_id, 0), '
     'coalesce(parent_id, 0), name COLLATE "gugu_natural_zh", id) WHERE deleted_at IS NULL'),
    ("ix_folders_page_id_scope", "folders",
     "(user_id, coalesce(project_id, workspace_directory_id, 0), "
     "coalesce(parent_id, 0), id) WHERE deleted_at IS NULL"),
)
_INDEXES += _FILES_PAGE_INDEXES + _FOLDERS_PAGE_INDEXES


def upgrade() -> None:
    op.execute(
        'CREATE COLLATION IF NOT EXISTS "gugu_natural_zh" '
        "(provider = icu, locale = 'zh-u-kn-true')"
    )
    # CONCURRENTLY 避免大表建索引期间阻塞文件增删改。每条命令单独走自动提交。
    with op.get_context().autocommit_block():
        for name, table, definition in _INDEXES:
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} {definition}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, _, _ in reversed(_INDEXES):
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
    # ICU collation 是可复用的数据库级对象，回滚索引时不删除它，避免
    # 误删迁移前已存在或被其他索引引用的同名 collation。
