"""将 IM 工具展示偏好统一为三档模式。

Revision ID: 20261022000001
Revises: 20261020000001
Create Date: 2026-10-22
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa


revision = "20261022000001"
down_revision = "20261020000001"
branch_labels = None
depends_on = None


def _legacy_mode(data: dict) -> str:
    if bool(data.get("show_tool_interactions", True)):
        return "all"
    return "slow_only" if bool(data.get("show_slow_tool_progress", True)) else "off"


def _read_rows(connection):
    return connection.execute(
        sa.text("SELECT user_id, data_json FROM user_preferences")
    ).mappings()


def upgrade() -> None:
    connection = op.get_bind()
    rows = _read_rows(connection).all()
    for row in rows:
        try:
            data = json.loads(row["data_json"] or "{}")
        except (TypeError, ValueError):
            # 保留损坏行原文，避免迁移顺手覆盖用户的其他偏好。
            continue
        if not isinstance(data, dict):
            continue

        mode = data.get("im_tool_display_mode")
        if not isinstance(mode, str) or mode not in {"off", "all", "slow_only"}:
            mode = _legacy_mode(data)
        data["im_tool_display_mode"] = mode
        data.pop("show_tool_interactions", None)
        data.pop("show_slow_tool_progress", None)
        connection.execute(
            sa.text("UPDATE user_preferences SET data_json = :data WHERE user_id = :user_id"),
            {"data": json.dumps(data, ensure_ascii=False), "user_id": row["user_id"]},
        )


def downgrade() -> None:
    connection = op.get_bind()
    rows = _read_rows(connection).all()
    for row in rows:
        try:
            data = json.loads(row["data_json"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue

        mode = data.get("im_tool_display_mode")
        if not isinstance(mode, str) or mode not in {"off", "all", "slow_only"}:
            mode = "all"
        data["show_tool_interactions"] = mode == "all"
        data["show_slow_tool_progress"] = mode in {"all", "slow_only"}
        data.pop("im_tool_display_mode", None)
        connection.execute(
            sa.text("UPDATE user_preferences SET data_json = :data WHERE user_id = :user_id"),
            {"data": json.dumps(data, ensure_ascii=False), "user_id": row["user_id"]},
        )
