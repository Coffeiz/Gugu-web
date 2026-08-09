"""`/admin/config/video-cache-snapshots` 端点（PRD-STORAGE-1 Phase B 存储占用
趋势面板）：直接调路由函数验证返回 shape 和按天数过滤，同 test_files_api.py
的风格（不起 TestClient）。"""
from datetime import timedelta

import pytest

from app.api.v1.config import video_cache_snapshots
from app.core.tz import now_utc
from app.models import VideoCacheSnapshot


@pytest.mark.asyncio
async def test_video_cache_snapshots_returns_recent_only(db):
    old = VideoCacheSnapshot(taken_at=now_utc() - timedelta(days=40), object_count=5, total_bytes=500)
    recent = VideoCacheSnapshot(taken_at=now_utc() - timedelta(days=1), object_count=2, total_bytes=200)
    db.add_all([old, recent])
    await db.commit()

    result = await video_cache_snapshots(days=30, db=db)

    assert len(result["snapshots"]) == 1
    assert result["snapshots"][0]["object_count"] == 2
    assert result["snapshots"][0]["total_bytes"] == 200


@pytest.mark.asyncio
async def test_video_cache_snapshots_empty_returns_empty_list(db):
    result = await video_cache_snapshots(days=30, db=db)
    assert result == {"snapshots": []}


@pytest.mark.asyncio
async def test_video_cache_snapshots_clamps_days_range(db):
    """days 参数被夹到 [1, 365]，避免传 0/负数/超大值。"""
    snap = VideoCacheSnapshot(taken_at=now_utc(), object_count=1, total_bytes=100)
    db.add(snap)
    await db.commit()

    result = await video_cache_snapshots(days=0, db=db)
    assert len(result["snapshots"]) == 1   # days=0 被夹到至少 1 天，今天的快照仍应出现

    result = await video_cache_snapshots(days=99999, db=db)
    assert len(result["snapshots"]) == 1
