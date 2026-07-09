"""encrypt user_bots.app_secret at rest（IM Bot 凭据补上静态加密）

Revision ID: 20260702000002
Revises: 20260702000001
Create Date: 2026-07-02

user_bots.app_secret 之前是明文落库（app_id 保持明文不变，见 app/core/crypto.py 里的
说明——它是公开标识符，qq_connect.py/feishu_connect.py 拿它做等值查询去重，加密会打断
匹配）。这里把列宽松成 TEXT（密文经 base64 后比明文长），再把历史明文行原地加密成
AES-256-GCM 密文。幂等：encrypt_secret() 对已经是密文的值直接原样返回，重跑不会二次加密。
"""
import sqlalchemy as sa
from alembic import op

revision = '20260702000002'
down_revision = '20260702000001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE user_bots ALTER COLUMN app_secret TYPE TEXT")

    from app.core.crypto import encrypt_secret

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, app_secret FROM user_bots")).fetchall()
    for row in rows:
        if not row.app_secret:
            continue
        conn.execute(
            sa.text("UPDATE user_bots SET app_secret = :s WHERE id = :id"),
            {"s": encrypt_secret(row.app_secret), "id": row.id},
        )


def downgrade():
    from app.core.crypto import decrypt_secret

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, app_secret FROM user_bots")).fetchall()
    for row in rows:
        if not row.app_secret:
            continue
        conn.execute(
            sa.text("UPDATE user_bots SET app_secret = :s WHERE id = :id"),
            {"s": decrypt_secret(row.app_secret), "id": row.id},
        )
    op.execute("ALTER TABLE user_bots ALTER COLUMN app_secret TYPE VARCHAR(256)")
