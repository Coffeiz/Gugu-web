"""为 Agent 用量记录调用场景（chat/reflection/compaction/knowledge）。"""
from alembic import op

revision = "20260910000001"
down_revision = "20260909000003"
branch_labels = None
depends_on = None

def upgrade():
    op.execute("ALTER TABLE agent_usage ADD COLUMN IF NOT EXISTS scenario VARCHAR(32) NOT NULL DEFAULT 'chat'")

def downgrade():
    op.execute("ALTER TABLE agent_usage DROP COLUMN IF EXISTS scenario")
