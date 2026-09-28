"""统一 BYOK 多模态能力列命名。"""

import sqlalchemy as sa
from alembic import op


revision = "20260928000001"
down_revision = "20260927000001"
branch_labels = None
depends_on = None


_RENAMES = (
    ("vision", "image"),
    ("vision_video", "video"),
    ("vision_audio", "audio"),
    ("vision_detail", "image_detail"),
)


def _rename_columns(pairs: tuple[tuple[str, str], ...]) -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("user_provider_credentials"):
        return
    columns = {column["name"] for column in inspector.get_columns("user_provider_credentials")}
    for old_name, new_name in pairs:
        if old_name in columns and new_name in columns:
            raise RuntimeError(
                f"user_provider_credentials 同时存在 {old_name} 和 {new_name}，拒绝覆盖数据"
            )
        if old_name in columns:
            op.alter_column(
                "user_provider_credentials", old_name, new_column_name=new_name
            )
            columns.remove(old_name)
            columns.add(new_name)
        elif new_name not in columns:
            raise RuntimeError(
                f"user_provider_credentials 缺少待迁移字段 {old_name}/{new_name}"
            )


def upgrade() -> None:
    _rename_columns(_RENAMES)


def downgrade() -> None:
    _rename_columns(tuple((new, old) for old, new in reversed(_RENAMES)))
