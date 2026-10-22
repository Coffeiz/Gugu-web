"""规范化群成员工具权限并保留 Provider 原生联网搜索。

Revision ID: 20261022000002
Revises: 20261022000001
Create Date: 2026-10-22
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261022000002"
down_revision = "20261022000001"
branch_labels = None
depends_on = None


_ALLOWED_TOOLS = frozenset({
    "xng_search", "web_search", "http_get", "similar_image_search",
    "read_file", "inspect_images", "send_file", "group_context_search",
})


def _normalize_group_tools(value):
    if not isinstance(value, list):
        return None

    tools = []
    for item in value:
        names = ("xng_search", "similar_image_search") if item == "image_search" else (item,)
        for name in names:
            if not isinstance(name, str) or name not in _ALLOWED_TOOLS:
                continue
            if name == "inspect_images":
                name = "read_file"
            if name not in tools:
                tools.append(name)

    for search_name in ("xng_search", "web_search"):
        if search_name in tools and "http_get" not in tools:
            tools.insert(tools.index(search_name) + 1, "http_get")
    if "similar_image_search" in tools and "read_file" not in tools:
        tools.insert(tools.index("similar_image_search") + 1, "read_file")
    return tools


def upgrade() -> None:
    connection = op.get_bind()
    table = sa.table(
        "user_bots",
        sa.column("id", sa.Integer),
        sa.column("group_allowed_tools", sa.JSON),
    )
    rows = connection.execute(
        sa.select(table.c.id, table.c.group_allowed_tools)
    ).mappings()
    for row in rows:
        normalized = _normalize_group_tools(row["group_allowed_tools"])
        if normalized is not None and normalized != row["group_allowed_tools"]:
            connection.execute(
                sa.update(table)
                .where(table.c.id == row["id"])
                .values(group_allowed_tools=normalized)
            )


def downgrade() -> None:
    # 权限清理不可逆；回滚代码后仍保留已经收敛的白名单，避免复活未知工具名。
    pass
