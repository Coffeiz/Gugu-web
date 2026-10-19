"""迁移用户字段中的旧搜索工具名。

Revision ID: 20261018000001
Revises: 20261016000001
Create Date: 2026-10-18
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261018000001"
down_revision = "20261016000001"
branch_labels = None
depends_on = None


_FORWARD = {
    "web_search": ("xng_search",),
    "image_search": ("xng_search", "similar_image_search"),
}
_BACKWARD = {
    "xng_search": ("web_search",),
    "similar_image_search": ("image_search",),
}


def _replace_names(value, mapping):
    if not isinstance(value, list):
        return None
    changed = False
    result = []
    for item in value:
        replacements = mapping.get(item) if isinstance(item, str) else None
        if replacements is None:
            replacements = (item,)
        else:
            changed = True
        for replacement in replacements:
            if replacement not in result:
                result.append(replacement)
    return result if changed else None


def _migrate_skill_snapshot(value, mapping):
    if not isinstance(value, dict):
        return None
    snapshots = value.get("user_skill_snapshot")
    if not isinstance(snapshots, list):
        return None
    changed = False
    migrated = []
    for item in snapshots:
        if not isinstance(item, dict):
            migrated.append(item)
            continue
        tools = _replace_names(item.get("related_tools"), mapping)
        if tools is None:
            migrated.append(item)
            continue
        copied = dict(item)
        copied["related_tools"] = tools
        migrated.append(copied)
        changed = True
    if not changed:
        return None
    result = dict(value)
    result["user_skill_snapshot"] = migrated
    return result


def _migrate_list_column(table_name, id_column, value_column, mapping):
    connection = op.get_bind()
    table = sa.table(
        table_name,
        sa.column(id_column, sa.Integer),
        sa.column(value_column, sa.JSON),
    )
    rows = connection.execute(sa.select(table.c[id_column], table.c[value_column]))
    for row in rows:
        migrated = _replace_names(row._mapping[value_column], mapping)
        if migrated is not None:
            connection.execute(
                sa.update(table)
                .where(table.c[id_column] == row._mapping[id_column])
                .values({value_column: migrated})
            )


def _migrate_session_snapshots(mapping):
    connection = op.get_bind()
    sessions = sa.table(
        "conversation_sessions",
        sa.column("id", sa.Integer),
        sa.column("session_context", sa.JSON),
    )
    rows = connection.execute(sa.select(sessions.c.id, sessions.c.session_context))
    for row in rows:
        migrated = _migrate_skill_snapshot(row._mapping["session_context"], mapping)
        if migrated is not None:
            connection.execute(
                sa.update(sessions)
                .where(sessions.c.id == row._mapping["id"])
                .values(session_context=migrated)
            )


def upgrade() -> None:
    op.add_column(
        "user_provider_credentials",
        sa.Column("web_search_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _migrate_list_column("user_bots", "id", "group_allowed_tools", _FORWARD)
    _migrate_list_column("user_skills", "id", "related_tools", _FORWARD)
    _migrate_session_snapshots(_FORWARD)
    op.execute("ALTER TABLE user_bots ALTER COLUMN group_allowed_tools SET DEFAULT '[\"xng_search\"]'::jsonb")


def downgrade() -> None:
    op.execute("ALTER TABLE user_bots ALTER COLUMN group_allowed_tools SET DEFAULT '[\"web_search\"]'::jsonb")
    _migrate_list_column("user_bots", "id", "group_allowed_tools", _BACKWARD)
    _migrate_list_column("user_skills", "id", "related_tools", _BACKWARD)
    _migrate_session_snapshots(_BACKWARD)
    op.drop_column("user_provider_credentials", "web_search_enabled")
