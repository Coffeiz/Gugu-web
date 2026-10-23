"""将历史工具展示迁移到唯一持久时间线。

Revision ID: 20261022000003
Revises: 20261022000002
"""
from types import SimpleNamespace

from alembic import op
import sqlalchemy as sa

from app.db.migrations.chat_timeline import migrate_session_timeline

revision = "20261022000003"
down_revision = "20261022000002"
branch_labels = None
depends_on = None
bootstrap_on_legacy_database = True


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        # 迁移期间允许读取，阻止新消息交错写入产生半迁移展示状态。
        connection.execute(sa.text("LOCK TABLE conversation_messages IN SHARE ROW EXCLUSIVE MODE"))
    table = sa.table("conversation_messages",
        sa.column("id", sa.Integer), sa.column("session_id", sa.Integer),
        sa.column("role", sa.String), sa.column("content", sa.Text),
        sa.column("content_json", sa.JSON), sa.column("display_timeline", sa.JSON),
        sa.column("files", sa.JSON), sa.column("run_id", sa.String),
        sa.column("round_id", sa.String), sa.column("canonical_batch_id", sa.Integer),
        sa.column("created_at", sa.DateTime))
    # 以会话为单位释放大 JSON，避免一次加载整库；所有修改由 Alembic 事务提交。
    last_session = -1
    while True:
        session_id = connection.execute(sa.select(table.c.session_id).where(
            table.c.session_id > last_session).order_by(table.c.session_id).limit(1)).scalar()
        if session_id is None:
            break
        rows = [SimpleNamespace(**row) for row in connection.execute(sa.select(table).where(
            table.c.session_id == session_id).order_by(table.c.id)).mappings()]
        for message_id, timeline in migrate_session_timeline(rows).items():
            connection.execute(sa.update(table).where(table.c.id == message_id).values(
                display_timeline=timeline if timeline else sa.null()))
        last_session = session_id


def downgrade() -> None:
    # 不恢复重复卡片；canonical 模型上下文始终保留，可以安全回滚代码。
    pass
