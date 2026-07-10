"""所有 datetime 列 timestamp → timestamptz（时区迁移 Phase 2）

Revision ID: 20260711000002
Revises: 20260711000001
Create Date: 2026-07-11

见 docs/backend/时区与时钟迁移方案.md Phase 2。模型侧已把这些列换成 `UtcDateTime`
（底层 timestamptz），本迁移把**存量库**里的 naive `timestamp` 列原地转成 `timestamptz`。

现有值本就是 UTC，故 `USING col AT TIME ZONE 'UTC'`（把 naive 值当 UTC 贴上时区），无语义漂移。

**幂等且安全**：每列先查 information_schema，仅当当前是 `timestamp without time zone` 才转——
这样已被 `create_all` 建成 timestamptz 的（全新库）跳过，不会二次 `AT TIME ZONE` 把值转坏。
"""
from alembic import op

revision = '20260711000002'
down_revision = '20260711000001'
branch_labels = None
depends_on = None

# 由模型枚举得到（app.db.types.UtcDateTime 列），见迁移说明
_COLS = [
    ('audit_logs', ['created_at']),
    ('site_notifications', ['bubble_expire_at', 'created_at']),
    ('system_logs', ['created_at']),
    ('users', ['created_at', 'last_active_at']),
    ('clients', ['created_at']),
    ('conversation_sessions', ['created_at', 'updated_at']),
    ('feedbacks', ['created_at']),
    ('frontend_events', ['created_at']),
    ('invite_codes', ['used_at', 'created_at']),
    ('mind_nodes', ['indexed_at', 'captured_at', 'created_at', 'updated_at', 'deleted_at']),
    ('notification_reads', ['read_at']),
    ('onboarding_state', ['created_at', 'updated_at']),
    ('projects', ['done_at', 'created_at', 'updated_at']),
    ('scheduled_tasks', ['last_run_at', 'created_at', 'updated_at']),
    ('search_usage', ['created_at']),
    ('user_bots', ['created_at']),
    ('user_preferences', ['updated_at']),
    ('agent_usage', ['created_at']),
    ('calendar_events', ['created_at']),
    ('conversation_messages', ['created_at']),
    ('folders', ['created_at']),
    ('mind_maps', ['created_at', 'updated_at']),
    ('mind_relations', ['created_at', 'updated_at']),
    ('files', ['created_at', 'updated_at', 'deleted_at']),
    ('mind_canvas_items', ['created_at', 'updated_at']),
]


def upgrade():
    for table, cols in _COLS:
        for c in cols:
            op.execute(f"""
                DO $$ BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = '{table}' AND column_name = '{c}'
                      AND data_type = 'timestamp without time zone'
                  ) THEN
                    ALTER TABLE {table} ALTER COLUMN {c}
                      TYPE timestamptz USING {c} AT TIME ZONE 'UTC';
                  END IF;
                END $$;
            """)


def downgrade():
    # 反向：timestamptz → naive timestamp（按 UTC 落回），仅当当前带时区时才转
    for table, cols in _COLS:
        for c in cols:
            op.execute(f"""
                DO $$ BEGIN
                  IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = '{table}' AND column_name = '{c}'
                      AND data_type = 'timestamp with time zone'
                  ) THEN
                    ALTER TABLE {table} ALTER COLUMN {c}
                      TYPE timestamp USING {c} AT TIME ZONE 'UTC';
                  END IF;
                END $$;
            """)
