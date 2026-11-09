"""Replace retired XNG permissions with Provider web search.

Revision ID: 20261109000001
Revises: 20261108000001
Create Date: 2026-11-09
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261109000001"
down_revision = "20261108000001"
branch_labels = None
depends_on = None


def _replace_tool_list(value):
    if not isinstance(value, list):
        return value
    result = []
    for item in value:
        name = "web_search" if item == "xng_search" else item
        if name not in result:
            result.append(name)
    if "web_search" in result and "http_get" not in result:
        result.insert(result.index("web_search") + 1, "http_get")
    return result


def _migrate_list_column(table_name: str, id_column: str, value_column: str) -> None:
    connection = op.get_bind()
    table = sa.table(
        table_name,
        sa.column(id_column, sa.Integer),
        sa.column(value_column, sa.JSON),
    )
    rows = connection.execute(sa.select(table.c[id_column], table.c[value_column])).mappings()
    for row in rows:
        current = row[value_column]
        updated = _replace_tool_list(current)
        if updated != current:
            connection.execute(
                sa.update(table)
                .where(table.c[id_column] == row[id_column])
                .values({value_column: updated})
            )


def _migrate_session_snapshots() -> None:
    connection = op.get_bind()
    table = sa.table(
        "conversation_sessions",
        sa.column("id", sa.Integer),
        sa.column("session_context", sa.JSON),
    )
    rows = connection.execute(sa.select(table.c.id, table.c.session_context)).mappings()
    for row in rows:
        context = row["session_context"]
        if not isinstance(context, dict):
            continue
        updated = dict(context)
        snapshots = updated.get("user_skill_snapshot")
        changed = False
        if isinstance(snapshots, list):
            migrated = []
            for snapshot in snapshots:
                if not isinstance(snapshot, dict):
                    migrated.append(snapshot)
                    continue
                item = dict(snapshot)
                tools = _replace_tool_list(item.get("related_tools"))
                if tools != item.get("related_tools"):
                    item["related_tools"] = tools
                    changed = True
                migrated.append(item)
            updated["user_skill_snapshot"] = migrated
        if changed:
            connection.execute(
                sa.update(table)
                .where(table.c.id == row["id"])
                .values(session_context=updated)
            )


def upgrade() -> None:
    _migrate_list_column("user_bots", "id", "group_allowed_tools")
    _migrate_list_column("user_skills", "id", "related_tools")
    _migrate_session_snapshots()
    op.execute("ALTER TABLE user_bots ALTER COLUMN group_allowed_tools SET DEFAULT '[\"web_search\"]'::jsonb")


def downgrade() -> None:
    # Downgrade restores the prior default; converted user grants stay on web_search,
    # which remains accepted by the previous release as well.
    op.execute("ALTER TABLE user_bots ALTER COLUMN group_allowed_tools SET DEFAULT '[\"xng_search\"]'::jsonb")
