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
# index.json 由 worker 以 JSON.stringify 写出，version 是第一个字段，读头部即可；
# 文件可能几十 MB，不能为了取一个版本戳整文件解析。
_INDEX_VERSION_RE = re.compile(rb'"version"\s*:\s*"([^"]*)"')
_INDEX_HEADER_BYTES = 8192


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


def _stamped_version(index_file: Path) -> str | None:
    """读索引文件头部的制品版本戳；读不到或格式不符返回 None（按未知处理）。"""
    try:
        with index_file.open("rb") as handle:
            head = handle.read(_INDEX_HEADER_BYTES)
    except OSError:
        return None
    match = _INDEX_VERSION_RE.search(head)
    return match.group(1).decode("utf-8", "replace") if match else None


def _is_newer_version(stamped: str, current: str) -> bool:
    """stamped 是否严格新于 current；任一侧解析不出数字段就返回 False（按「不比当前新」处理）。

    保护回滚场景：制品降级后不该把新版本写下的索引当旧数据清掉——它们是未来升级回去
    时仍然有效的缓存，删了只会让所有活跃用户重来一次冷重建。
    """
    def parts(value: str) -> list[int] | None:
        try:
            return [int(piece) for piece in value.split(".")]
        except (TypeError, ValueError):
            return None

    left, right = parts(stamped), parts(current)
    return left is not None and right is not None and left > right


def _is_stale_index_dir(
    path: Path, *, cutoff: float, active_dirs: set[Path], current_version: str | None,
) -> bool:
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
        # 旧制品写下的索引，当前 worker 恢复时会判 version_mismatch 直接丢弃重建，
        # 内容确定不会被复用，属于死数据，不必再等 TTL 到期（「重建完成后清理旧版本」）。
        # 只清严格更旧的版本：比当前新的留着，回滚后再升回去还是有效缓存。
        stamped = _stamped_version(index_file)
        if current_version and stamped and stamped != current_version:
            if not _is_newer_version(stamped, current_version):
                return True
        return index_file.stat().st_mtime < cutoff
    except OSError:
        return False


def _configured_ttl() -> int:
    from app.core.config import get_settings

    return int(get_settings().search.ts_sidecar_index_ttl_seconds)


async def sweep_ts_index_cache() -> int:
    """删除过期的 owner 索引目录，返回删除目录数量。"""
    from app.core import redis as R
    from agent.rag.ts_sidecar import active_index_dirs, worker_artifact_version

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
        # 制品版本取不到时按未知处理：只按 TTL 清理，绝不因为「比对不了」删数据。
        current_version = worker_artifact_version()
        for root in roots:
            for child in root.iterdir():
                if not _is_stale_index_dir(
                    child, cutoff=cutoff, active_dirs=protected, current_version=current_version,
                ):
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
