"""全局搜索 ILIKE 子串匹配的 PostgreSQL trigram 索引。

Revision ID: 20260711000003
Revises: 20260711000002
Create Date: 2026-07-11

普通 B-tree 无法加速 ``ILIKE '%关键词%'``。pg_trgm 对中文逐字子串和拉丁文片段都有效，
并保留现有查询语义；用户隔离仍由各查询的 user_id 条件负责。
"""
from alembic import op

revision = "20260711000003"
down_revision = "20260711000002"
branch_labels = None
depends_on = None


_INDEXES = (
    ("ix_search_projects_name_trgm", "projects", "name"),
    ("ix_search_projects_client_trgm", "projects", "client"),
    ("ix_search_projects_stage_trgm", "projects", "current_stage"),
    ("ix_search_files_name_trgm", "files", "display_name"),
    ("ix_search_files_ext_trgm", "files", "ext"),
    ("ix_search_folders_name_trgm", "folders", "name"),
    ("ix_search_events_title_trgm", "calendar_events", "title"),
    ("ix_search_events_description_trgm", "calendar_events", "description"),
    ("ix_search_events_client_trgm", "calendar_events", "client"),
    ("ix_search_clients_name_trgm", "clients", "name"),
    ("ix_search_clients_contact_trgm", "clients", "contact"),
    ("ix_search_clients_email_trgm", "clients", "email"),
    ("ix_search_clients_phone_trgm", "clients", "phone"),
    ("ix_search_clients_notes_trgm", "clients", "notes"),
    ("ix_search_sessions_title_trgm", "conversation_sessions", "title"),
    ("ix_search_messages_content_trgm", "conversation_messages", "content"),
)


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    for name, table, column in _INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} USING gin ({column} gin_trgm_ops)")
    # 记录正文是唯一会随全文搜索增长的思维字段，做部分索引避免把 ref/墓碑也塞进去。
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_search_mind_notes_plain_trgm
        ON mind_nodes USING gin (content_plain gin_trgm_ops)
        WHERE kind = 'note' AND deleted_at IS NULL
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_search_mind_notes_title_trgm
        ON mind_nodes USING gin (title gin_trgm_ops)
        WHERE kind = 'note' AND deleted_at IS NULL
    """)


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_search_mind_notes_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_search_mind_notes_plain_trgm")
    for name, _, _ in _INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    # 不卸 pg_trgm：可能被同库其他迁移/业务索引共用。
