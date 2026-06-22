"""migrate users.id to UUID v7

Revision ID: 20260622000004
Revises: 20260622000003
Create Date: 2026-06-22 00:00:00
"""
import sqlalchemy as sa
from alembic import op

revision = '20260622000004'
down_revision = '20260622000003'
branch_labels = None
depends_on = None

# 所有引用 users.id 的子表（有 user_id 列）
_CHILD_TABLES = [
    "user_preferences",
    "projects",
    "files",
    "folders",
    "mind_maps",
    "calendar_events",
    "clients",
    "conversation_sessions",
]

# user_preferences.user_id 有 UNIQUE 约束
_UNIQUE_USER_ID_TABLES = {"user_preferences"}


def upgrade():
    from uuid6 import uuid7

    bind = op.get_bind()

    # ── 1. 给 users 加 uuid 列 ────────────────────────────────────────────────
    op.execute("ALTER TABLE users ADD COLUMN uid UUID")

    # ── 2. 为每个现有用户生成 uuid7 ──────────────────────────────────────────
    rows = bind.execute(sa.text("SELECT id FROM users ORDER BY id")).fetchall()
    for (old_id,) in rows:
        new_uuid = uuid7()
        bind.execute(
            sa.text("UPDATE users SET uid = :uuid WHERE id = :id"),
            {"uuid": str(new_uuid), "id": old_id},
        )

    op.execute("ALTER TABLE users ALTER COLUMN uid SET NOT NULL")

    # ── 3. 子表：加新列、填值、删旧列、改名 ──────────────────────────────────
    for table in _CHILD_TABLES:
        op.execute(f"ALTER TABLE {table} ADD COLUMN new_user_id UUID")
        op.execute(
            f"UPDATE {table} t SET new_user_id = u.uid FROM users u WHERE u.id = t.user_id"
        )
        # 删旧 FK 约束（PostgreSQL 默认命名）
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_user_id_fkey")
        # 删旧索引
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_user_id")
        # 删旧列
        op.execute(f"ALTER TABLE {table} DROP COLUMN user_id")
        # 改名
        op.execute(f"ALTER TABLE {table} RENAME COLUMN new_user_id TO user_id")
        # NOT NULL
        op.execute(f"ALTER TABLE {table} ALTER COLUMN user_id SET NOT NULL")

    # ── 4. 替换 users 主键 ────────────────────────────────────────────────────
    op.execute("ALTER TABLE users DROP CONSTRAINT users_pkey")
    op.execute("ALTER TABLE users DROP COLUMN id")
    op.execute("ALTER TABLE users RENAME COLUMN uid TO id")
    op.execute("ALTER TABLE users ADD PRIMARY KEY (id)")

    # ── 5. 重建子表 FK 约束与索引 ────────────────────────────────────────────
    for table in _CHILD_TABLES:
        op.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {table}_user_id_fkey "
            f"FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
        )
        op.execute(f"CREATE INDEX ix_{table}_user_id ON {table}(user_id)")
        if table in _UNIQUE_USER_ID_TABLES:
            op.execute(
                f"ALTER TABLE {table} ADD CONSTRAINT {table}_user_id_unique UNIQUE (user_id)"
            )


def downgrade():
    raise NotImplementedError("UUID → int 降级不支持（数据不可逆）")
