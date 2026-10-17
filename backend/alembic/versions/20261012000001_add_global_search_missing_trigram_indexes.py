"""补齐全局搜索遗漏字段的 pg_trgm GIN 索引。

Revision ID: 20261012000001
Revises: 20261010000001
Create Date: 2026-10-12
"""
from alembic import op
from sqlalchemy import inspect


revision = "20261012000001"
down_revision = "20261010000001"
branch_labels = None
depends_on = None
bootstrap_on_empty_database = True


_INDEXES = (
    ("ix_search_skills_name_trgm", "user_skills", "name"),
    ("ix_search_skills_slug_trgm", "user_skills", "slug"),
    ("ix_search_skills_short_description_trgm", "user_skills", "description_short"),
    ("ix_search_skills_long_description_trgm", "user_skills", "description_long"),
    ("ix_search_mcp_servers_name_trgm", "user_mcp_servers", "name"),
    ("ix_search_scheduled_tasks_name_trgm", "scheduled_tasks", "name"),
)


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    connection = op.get_bind()
    for name, table, column in _INDEXES:
        # 空库 bootstrap 使用当前 ORM schema，而不是逐个重放完整历史迁移。
        # 某些字段（例如后续已删除的 user_skills.slug）在该 schema 中不存在，
        # 因此只为当前仍存在的列创建索引。正常历史升级到此处时仍会建立 slug 索引。
        columns = {item["name"] for item in inspect(connection).get_columns(table)}
        if column not in columns:
            continue
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} USING gin ({column} gin_trgm_ops)")
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_search_canvas_notes_plain_trgm
        ON mind_nodes USING gin (content_plain gin_trgm_ops)
        WHERE kind = 'canvas_note' AND deleted_at IS NULL
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_search_canvas_notes_title_trgm
        ON mind_nodes USING gin (title gin_trgm_ops)
        WHERE kind = 'canvas_note' AND deleted_at IS NULL
    """)


def downgrade():
    for name, _, _ in _INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    op.execute("DROP INDEX IF EXISTS ix_search_canvas_notes_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_search_canvas_notes_plain_trgm")
