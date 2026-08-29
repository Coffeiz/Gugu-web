"""为 Agent 用量记录缓存读写 token。"""
from alembic import op

revision = "20260823000007"
down_revision = "20260823000001"
branch_labels = None
depends_on = None

def upgrade():
    op.execute("ALTER TABLE agent_usage ADD COLUMN IF NOT EXISTS cache_read INTEGER NOT NULL DEFAULT 0")
    op.execute("ALTER TABLE agent_usage ADD COLUMN IF NOT EXISTS cache_write INTEGER NOT NULL DEFAULT 0")

def downgrade():
    op.execute("ALTER TABLE agent_usage DROP COLUMN IF EXISTS cache_read")
    op.execute("ALTER TABLE agent_usage DROP COLUMN IF EXISTS cache_write")
