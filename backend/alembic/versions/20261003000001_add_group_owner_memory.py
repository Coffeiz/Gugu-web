"""群聊个人记忆召回默认关闭。"""
from alembic import op
import sqlalchemy as sa

revision = "20261003000001"
down_revision = "20261002000002"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("user_bots", sa.Column("group_owner_memory_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("user_bots", "group_owner_memory_enabled")
