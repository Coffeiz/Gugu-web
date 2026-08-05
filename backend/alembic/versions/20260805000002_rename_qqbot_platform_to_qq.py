"""统一 QQ 平台标识为 qq。"""

from alembic import op


revision = "20260805000002"
down_revision = "20260805000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 运行时平台值统一为 qq；迁移幂等，便于已执行过部分数据修复的开发库重跑。
    for table, column in (
        ("user_bots", "platform"),
        ("conversation_sessions", "source"),
        ("memory_reflection_jobs", "platform"),
        ("memory_reflection_cursors", "platform"),
        ("memory_entries", "platform"),
        ("memory_scope_tombstones", "platform"),
    ):
        op.execute(
            f"UPDATE {table} SET {column} = 'qq' "
            f"WHERE {column} = 'qqbot'"
        )

    # 历史定时任务把目标保存在 JSON 中，顶层 key 就是平台标识（如
    # {"qqbot": {"chat_id": "...", "puid": "..."}}）。只改这一层 key 名，不做整段
    # JSON 文本替换——文本替换会把 chat_id/puid 等值里凡是包含 "qqbot"/"qq" 子串的
    # 部分也一起改掉（downgrade 用短的通用子串 "qq" 尤其容易误伤，见 P2 复查）。
    # delivery_targets 列声明的是 json 类型，jsonb 的 -/?/|| 操作符要先转 jsonb 再转回。
    op.execute(
        "UPDATE scheduled_tasks "
        "SET delivery_targets = ("
        "  (delivery_targets::jsonb - 'qqbot')"
        "  || jsonb_build_object('qq', delivery_targets::jsonb -> 'qqbot')"
        ")::json "
        "WHERE delivery_targets IS NOT NULL "
        "AND (delivery_targets::jsonb) ? 'qqbot'"
    )


def downgrade() -> None:
    for table, column in (
        ("user_bots", "platform"),
        ("conversation_sessions", "source"),
        ("memory_reflection_jobs", "platform"),
        ("memory_reflection_cursors", "platform"),
        ("memory_entries", "platform"),
        ("memory_scope_tombstones", "platform"),
    ):
        op.execute(
            f"UPDATE {table} SET {column} = 'qqbot' "
            f"WHERE {column} = 'qq'"
        )
    op.execute(
        "UPDATE scheduled_tasks "
        "SET delivery_targets = ("
        "  (delivery_targets::jsonb - 'qq')"
        "  || jsonb_build_object('qqbot', delivery_targets::jsonb -> 'qq')"
        ")::json "
        "WHERE delivery_targets IS NOT NULL "
        "AND (delivery_targets::jsonb) ? 'qq'"
    )
