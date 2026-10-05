"""从持久化用户 Skill 和会话快照中清除已退役的 run_script 关联。

Revision ID: 20261004000002
Revises: 20261004000001
Create Date: 2026-10-04
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20261004000002"
down_revision = "20261004000001"
branch_labels = None
depends_on = None


_RETIRED_TOOL = "run_script"


def _without_retired_tool(value):
    if not isinstance(value, list) or _RETIRED_TOOL not in value:
        return None
    return [item for item in value if item != _RETIRED_TOOL]


def _clean_skill_snapshot(value):
    if not isinstance(value, dict):
        return None
    snapshot = value.get("user_skill_snapshot")
    if not isinstance(snapshot, list):
        return None

    changed = False
    cleaned_snapshot = []
    for item in snapshot:
        if not isinstance(item, dict):
            cleaned_snapshot.append(item)
            continue
        cleaned_tools = _without_retired_tool(item.get("related_tools"))
        if cleaned_tools is None:
            cleaned_snapshot.append(item)
            continue
        cleaned_item = dict(item)
        cleaned_item["related_tools"] = cleaned_tools
        cleaned_snapshot.append(cleaned_item)
        changed = True

    if not changed:
        return None
    cleaned_context = dict(value)
    cleaned_context["user_skill_snapshot"] = cleaned_snapshot
    return cleaned_context


def upgrade() -> None:
    connection = op.get_bind()
    user_skills = sa.table(
        "user_skills",
        sa.column("id", sa.Integer),
        sa.column("related_tools", sa.JSON),
    )
    for row in connection.execute(sa.select(user_skills.c.id, user_skills.c.related_tools)):
        cleaned = _without_retired_tool(row.related_tools)
        if cleaned is not None:
            connection.execute(
                sa.update(user_skills)
                .where(user_skills.c.id == row.id)
                .values(related_tools=cleaned)
            )

    sessions = sa.table(
        "conversation_sessions",
        sa.column("id", sa.Integer),
        sa.column("session_context", sa.JSON),
    )
    for row in connection.execute(sa.select(sessions.c.id, sessions.c.session_context)):
        cleaned = _clean_skill_snapshot(row.session_context)
        if cleaned is not None:
            connection.execute(
                sa.update(sessions)
                .where(sessions.c.id == row.id)
                .values(session_context=cleaned)
            )


def downgrade() -> None:
    # 退役工具关联无法安全恢复；Skill 的其他工具关联与会话字段均由升级保留。
    pass
