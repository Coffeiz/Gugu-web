"""活动文件路径需唯一，软删除历史仍可保留相同路径。"""

from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import File


def _file(user_id, *, deleted_at=None):
    return File(
        user_id=user_id,
        display_name="笔记",
        ext="md",
        storage_key=f"{user_id}/personal/notes.md",
        deleted_at=deleted_at,
    )


async def test_active_file_storage_key_is_unique_but_soft_deleted_history_is_allowed(
    db, user_a, user_b,
):
    user_a_id = user_a.id
    user_b_id = user_b.id
    original = _file(user_a_id)
    db.add(original)
    await db.flush()

    duplicate = _file(user_a_id)
    db.add(duplicate)
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()

    # 不同用户隔离；同一用户的历史软删除行不占用活动路径。
    db.add(_file(user_b_id))
    db.add(_file(user_a_id, deleted_at=datetime.now(timezone.utc)))
    db.add(_file(user_a_id))
    await db.flush()
