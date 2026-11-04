"""清理过期的 Cython RAG 派生索引快照。"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from app.core import scheduler
from app.core.redaction import diag_log
from app.core.tz import now_utc

_LOCK_KEY = "rag:cython-index:gc:lock"
_LOCK_TIMEOUT = 1800
_CACHE_TAG_DIR = re.compile(r"^[0-9a-f]{20}$")
_USER_DIR = re.compile(r"^[0-9a-f-]{36}$", re.IGNORECASE)


def _index_roots() -> list[Path]:
    from app.core.config import get_settings

    local_path = getattr(get_settings().storage, "local_path", "")
    if not local_path:
        return []
    storage_root = Path(local_path).expanduser()
    if not storage_root.is_dir() or storage_root.is_symlink():
        return []
    return [
        user_dir / ".agent" / "rag" / "cython"
        for user_dir in storage_root.iterdir()
        if _USER_DIR.fullmatch(user_dir.name) and not user_dir.is_symlink()
    ]


def _is_stale_snapshot(path: Path, *, cutoff: float) -> bool:
    if (not path.is_dir() or path.is_symlink()
            or not _CACHE_TAG_DIR.fullmatch(path.name)):
        return False
    index_file = path / "index.json"
    if not index_file.is_file() or index_file.is_symlink():
        return False
    try:
        # 原子写入尚未完成时保留快照，交由下一轮 GC 检查。
        if (path / "index.json.tmp").exists():
            return False
        return index_file.stat().st_mtime < cutoff
    except OSError:
        return False


def _configured_ttl() -> int:
    from app.core.config import get_settings

    return int(get_settings().search.rag_index_ttl_seconds)


async def sweep_cython_index_cache() -> int:
    """删除超过保留期的 Cython 索引快照目录，返回删除数量。"""
    from app.core import redis as R

    roots = [root for root in _index_roots() if root.is_dir() and not root.is_symlink()]
    if not roots:
        return 0
    lock = R.get_redis().lock(_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return 0
    deleted = 0
    try:
        cutoff = now_utc().timestamp() - _configured_ttl()
        for root in roots:
            for snapshot_dir in root.iterdir():
                if not _is_stale_snapshot(snapshot_dir, cutoff=cutoff):
                    continue
                try:
                    shutil.rmtree(snapshot_dir)
                    deleted += 1
                except OSError as exc:
                    diag_log("app.core.rag_index_gc.delete", exc)
        return deleted
    finally:
        try:
            await lock.release()
        except Exception:
            pass


@scheduler.register(scheduler.cron(hour=0, minute=0), id="rag_cython_index_gc", name="RAG 索引快照清理")
async def _run_cython_index_gc() -> None:
    try:
        count = await sweep_cython_index_cache()
        if count:
            print(f"[rag_index_gc] 清理了 {count} 个过期 Cython 索引快照", flush=True)
    except Exception as exc:
        diag_log("app.core.rag_index_gc.sweep", exc)


__all__ = ["sweep_cython_index_cache"]
