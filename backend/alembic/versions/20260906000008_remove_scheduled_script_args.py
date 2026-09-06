"""移除定时脚本授权中的 positional args，统一使用运行时环境变量。"""
import json

from alembic import op
import sqlalchemy as sa


revision = "20260906000008"
down_revision = "20260906000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "scheduled_tasks" not in set(sa.inspect(bind).get_table_names()):
        return
    rows = bind.execute(sa.text(
        "SELECT id, script_authorization FROM scheduled_tasks "
        "WHERE script_authorization IS NOT NULL"
    )).fetchall()
    for task_id, raw in rows:
        value = raw
        if isinstance(raw, str):
            try:
                value = json.loads(raw)
            except (TypeError, ValueError):
                continue
        if not isinstance(value, dict) or "args" not in value:
            continue
        value = {key: item for key, item in value.items() if key != "args"}
        bind.execute(
            sa.text("UPDATE scheduled_tasks SET script_authorization = :value WHERE id = :id"),
            {"id": task_id, "value": json.dumps(value, ensure_ascii=False)},
        )


def downgrade() -> None:
    # positional args 已不再具有安全且稳定的语义，不能从迁移后的数据恢复。
    pass
