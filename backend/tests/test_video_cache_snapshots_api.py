"""`/admin/ops/storage-snapshots` 端点（PRD-STORAGE-2 存储监控面板）：直接调
路由函数验证按 category 分组、按天数过滤的返回 shape，同 test_files_api.py
的风格（不起 TestClient）。"""
from datetime import timedelta

import pytest

from app.api.v1.ops_admin import storage_snapshots_history
from app.core.tz import now_utc
from app.models import StorageCategorySnapshot


@pytest.mark.asyncio
async def test_storage_snapshots_groups_by_category(db):
    db.add_all([
        StorageCategorySnapshot(category="video_cache", taken_at=now_utc(), object_count=2, total_bytes=200),
        StorageCategorySnapshot(category="user_files", taken_at=now_utc(), object_count=5, total_bytes=5000),
    ])
    await db.commit()

    result = await storage_snapshots_history(days=30, db=db)

    assert set(result["categories"].keys()) == {"video_cache", "user_files"}
    assert result["categories"]["video_cache"][0]["object_count"] == 2
    assert result["categories"]["user_files"][0]["total_bytes"] == 5000


@pytest.mark.asyncio
async def test_storage_snapshots_filters_by_days(db):
    old = StorageCategorySnapshot(category="video_cache", taken_at=now_utc() - timedelta(days=40),
                                  object_count=9, total_bytes=900)
    recent = StorageCategorySnapshot(category="video_cache", taken_at=now_utc() - timedelta(days=1),
                                     object_count=1, total_bytes=100)
    db.add_all([old, recent])
    await db.commit()

    result = await storage_snapshots_history(days=30, db=db)

    assert len(result["categories"]["video_cache"]) == 1
    assert result["categories"]["video_cache"][0]["object_count"] == 1


@pytest.mark.asyncio
async def test_storage_snapshots_empty_returns_empty_dict(db, monkeypatch):
    import app.api.v1.ops_admin as ops_admin
    monkeypatch.setattr(ops_admin, "_disk_usage_if_local", lambda: None)
    result = await storage_snapshots_history(days=30, db=db)
    assert result == {"categories": {}, "disk": None}


@pytest.mark.asyncio
async def test_disk_usage_none_when_oss_backend(monkeypatch):
    from app.api.v1.ops_admin import _disk_usage_if_local
    from types import SimpleNamespace
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(backend="oss", local_path="./uploads")))
    assert _disk_usage_if_local() is None


@pytest.mark.asyncio
async def test_disk_usage_returns_numbers_when_local_backend(tmp_path, monkeypatch):
    from app.api.v1.ops_admin import _disk_usage_if_local
    from types import SimpleNamespace
    monkeypatch.setattr(
        "app.core.config.get_settings",
        lambda: SimpleNamespace(storage=SimpleNamespace(backend="local", local_path=str(tmp_path))))
    result = _disk_usage_if_local()
    assert result is not None
    assert result["total_bytes"] > 0
    assert result["free_bytes"] >= 0
    assert result["used_bytes"] >= 0
