"""记录定时任务触发，避免未知结果自动重放。"""
from alembic import op
import sqlalchemy as sa

revision = '20261115000007'
down_revision = '20261115000006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'scheduled_task_fires',
        sa.Column('task_id', sa.Integer(), nullable=False),
        sa.Column('fire_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('lease_owner', sa.String(128), nullable=False),
        sa.Column('status', sa.String(16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('task_id', 'fire_at'),
    )


def downgrade() -> None:
    op.drop_table('scheduled_task_fires')
