"""refactor files storage: drop file_versions/folders, add space/stage/storage_key, create mind_maps

Revision ID: 20260617000001
Revises: 20260616135619
Create Date: 2026-06-17 00:00:01

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = '20260617000001'
down_revision: Union[str, None] = '20260616135619'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. 删除旧表（CASCADE 自动处理 FK） ──────────────────────────────────────
    op.execute("DROP TABLE IF EXISTS file_versions CASCADE")
    op.execute("DROP TABLE IF EXISTS folders CASCADE")

    # ── 2. 新建 mind_maps 表 ─────────────────────────────────────────────────────
    op.create_table(
        'mind_maps',
        sa.Column('id',         sa.Integer(),     primary_key=True, autoincrement=True),
        sa.Column('user_id',    sa.Integer(),     sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
        sa.Column('title',      sa.String(300),   nullable=False),
        sa.Column('project_id', sa.Integer(),     sa.ForeignKey('projects.id', ondelete='SET NULL'), nullable=True),
        sa.Column('data_json',  sa.Text(),        nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(),    nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(),    nullable=False, server_default=sa.func.now()),
    )

    # ── 3. 在 files 表添加新列（带 server_default 保证已有行不报错）─────────────
    op.add_column('files', sa.Column('space',       sa.String(20),  nullable=False, server_default='personal'))
    op.add_column('files', sa.Column('stage_name',  sa.String(100), nullable=False, server_default=''))
    op.add_column('files', sa.Column('storage_key', sa.String(500), nullable=False, server_default=''))
    op.add_column('files', sa.Column('size_bytes',  sa.BigInteger(), nullable=False, server_default='0'))
    op.add_column('files', sa.Column('mime_type',   sa.String(200), nullable=True))
    op.add_column('files', sa.Column('mind_map_id', sa.Integer(),   sa.ForeignKey('mind_maps.id', ondelete='SET NULL'), nullable=True))

    # updated_at 可能不存在于旧 files 表
    op.execute("""
        ALTER TABLE files
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE
            NOT NULL DEFAULT NOW()
    """)

    # ── 4. 删除 files 旧列（IF EXISTS，哪列不存在就跳过）─────────────────────────
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS folder_id")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS note")
    op.execute("ALTER TABLE files DROP COLUMN IF EXISTS path")

    # ── 5. 清除 server_default（保持与 ORM 一致，由 Python 负责默认值）───────────
    op.alter_column('files', 'space',       server_default=None)
    op.alter_column('files', 'stage_name',  server_default=None)
    op.alter_column('files', 'storage_key', server_default=None)
    op.alter_column('files', 'size_bytes',  server_default=None)


def downgrade() -> None:
    # 恢复旧列
    op.add_column('files', sa.Column('folder_id', sa.Integer(), nullable=True))
    op.add_column('files', sa.Column('note',      sa.Text(),    nullable=True))

    # 删除新列
    op.drop_column('files', 'mind_map_id')
    op.drop_column('files', 'mime_type')
    op.drop_column('files', 'size_bytes')
    op.drop_column('files', 'storage_key')
    op.drop_column('files', 'stage_name')
    op.drop_column('files', 'space')

    # 删除 mind_maps 表
    op.drop_table('mind_maps')
