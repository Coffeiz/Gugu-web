"""会话标题加 title_locked 字段（防自动标题覆盖手动改名）。

背景：自动标题任务在用户首轮回复后异步启动（runner._schedule_title），与
rename_session API 写同一 title 字段，存在竞态：手动改名可能被异步返回的
自动标题静默覆盖。

修复：rename_session API 把 title_locked 置 True；_gen_title_bg 在写 title
前先查 title_locked，是 True 则跳过，不再覆盖手动改的标题。手动改名一劳永逸
地赢下竞态。
"""

from alembic import op


revision = "20260807000001"
down_revision = "20260805000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_sessions ADD COLUMN IF NOT EXISTS "
        "title_locked BOOLEAN NOT NULL DEFAULT FALSE"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_sessions DROP COLUMN IF EXISTS title_locked")
