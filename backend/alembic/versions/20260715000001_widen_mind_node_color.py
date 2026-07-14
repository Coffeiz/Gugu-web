"""widen mind_nodes.color from varchar(30) to varchar(300)

Revision ID: 20260715000001
Revises: 20260714000002
Create Date: 2026-07-15

项目引用创建时缓存 Project.color 快照（见 20260714000001 附近改动）——项目的 color
可以是完整 CSS 渐变字符串（默认值 "linear-gradient(135deg,#7b7fb2,#c4afc8)" 就有 38
字符），远超便签 color 用的 amber/coral/blue/teal 短枚举值撑起的 varchar(30)，导致渐变色
项目第一次建 ref 节点插入直接报 StringDataRightTruncationError（"没拖过画布的项目卡
添加失败、拖过的正常"，因为已有 ref 节点走复用分支不会再 INSERT）。加宽到跟
Project.color 本身一致的 300，ALTER COLUMN 改宽度是 metadata-only 变更，不锁表、
存量数据不用回填。
"""
import sqlalchemy as sa
from alembic import op

revision = "20260715000001"
down_revision = "20260714000002"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("mind_nodes", "color", type_=sa.String(length=300))


def downgrade():
    op.alter_column("mind_nodes", "color", type_=sa.String(length=30))
