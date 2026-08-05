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

    # 历史定时任务把目标保存在 JSON 中，旧目标也要指向新的平台标识。
    op.execute(
        "UPDATE scheduled_tasks "
        "SET delivery_targets = replace(delivery_targets::text, 'qqbot', 'qq')::json "
        "WHERE delivery_targets IS NOT NULL "
        "AND delivery_targets::text LIKE '%qqbot%'"
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
        "SET delivery_targets = replace(delivery_targets::text, 'qq', 'qqbot')::json "
        "WHERE delivery_targets IS NOT NULL "
        "AND delivery_targets::text LIKE '%qq%'"
    )
