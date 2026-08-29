"""TypeScript RAG 用户索引缓存清理。

索引是可重建的派生缓存，不属于用户业务数据。清理按 RAG 的索引保留 TTL 执行，
与 TS worker 的进程空闲 TTL 分开，避免把内存进程生命周期误当成磁盘数据生命周期。
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from app.core import scheduler
from app.core.redaction import diag_log
from app.core.tz import now_utc

_LOCK_KEY = "rag:ts-index:gc:lock"
_LOCK_TIMEOUT = 1800
_OWNER_DIR = re.compile(r"^[0-9a-f]{32}$")
_USER_DIR = re.compile(r"^[0-9a-f-]{36}$", re.IGNORECASE)


def _index_roots() -> list[Path]:
    from app.core.config import get_settings

    settings = get_settings()
    roots: list[Path] = []
    local_path = getattr(settings.storage, "local_path", "")
    if local_path:
        storage_root = Path(local_path).expanduser()
        if storage_root.is_dir() and not storage_root.is_symlink():
            for user_dir in storage_root.iterdir():
                if _USER_DIR.fullmatch(user_dir.name) and not user_dir.is_symlink():
                    roots.append(user_dir / ".system" / "rag" / "ts-index")
    # 旧 backend/var/rag-ts-index 只保留兼容清理，新的索引不会再写入这里。
    legacy = settings.search.ts_sidecar_index_dir.strip()
    if legacy:
        roots.append(Path(legacy).expanduser())
    return roots


def _is_stale_index_dir(path: Path, *, cutoff: float, active_dirs: set[Path]) -> bool:
    if not path.is_dir() or path.is_symlink() or not _OWNER_DIR.fullmatch(path.name):
        return False
    if path.resolve() in active_dirs:
        return False
    index_file = path / "index.json"
    if not index_file.is_file() or index_file.is_symlink():
        return False
    try:
        # TS worker 使用临时文件 + rename；存在临时文件时视为正在写入，留到下一轮。
        if (path / "index.json.tmp").exists():
            return False
        return index_file.stat().st_mtime < cutoff
    except OSError:
        return False


def _configured_ttl() -> int:
    from app.core.config import get_settings

    return int(get_settings().search.ts_sidecar_index_ttl_seconds)


async def sweep_ts_index_cache() -> int:
    """删除过期的 owner 索引目录，返回删除目录数量。"""
    from app.core import redis as R
    from agent.rag.ts_sidecar import active_index_dirs

    roots = [root for root in _index_roots() if root.is_dir() and not root.is_symlink()]
    if not roots:
        return 0
    lock = R.get_redis().lock(_LOCK_KEY, timeout=_LOCK_TIMEOUT, blocking=False)
    if not await lock.acquire(blocking=False):
        return 0
    deleted = 0
    try:
        cutoff = now_utc().timestamp() - _configured_ttl()
        protected = {path.resolve() for path in active_index_dirs()}
        for root in roots:
            for child in root.iterdir():
                if not _is_stale_index_dir(child, cutoff=cutoff, active_dirs=protected):
                    continue
                try:
                    shutil.rmtree(child)
                    deleted += 1
                except OSError as exc:
                    diag_log("app.core.rag_index_gc.delete", exc)
        return deleted
    finally:
        try:
            await lock.release()
        except Exception:
            pass


@scheduler.register(scheduler.cron(hour=0, minute=0), id="rag_ts_index_gc", name="RAG 用户索引缓存清理")
async def _run_ts_index_gc() -> None:
    try:
        count = await sweep_ts_index_cache()
        if count:
            print(f"[rag_index_gc] 清理了 {count} 个过期用户索引缓存", flush=True)
    except Exception as exc:
        diag_log("app.core.rag_index_gc.sweep", exc)


__all__ = ["sweep_ts_index_cache"]
