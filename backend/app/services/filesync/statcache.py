"""已同步文件的 stat 缓存：size+mtime 未变则复用上次内容指纹，避免重复哈希。

缓存按 (user, binding) 一份，落在 .filesync-snapshots 目录旁边；日级补偿扫描
会带 use_stat_cache=False 强制全量哈希，统计信息相同但内容不同的漂移由那一轮
自愈，所以这里允许 size+mtime 这个标准启发式。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from app.core.config import get_settings


def _cache_path(user_id, binding_id: int) -> Path:
    storage_root = Path(get_settings().storage.local_path).expanduser().resolve()
    return (
        storage_root.parent / ".filesync-snapshots" / str(user_id) / str(binding_id)
        / "stat-cache.json"
    )


class StatCache:
    """单轮 reconcile 内加载、退出时按 seen 集合裁剪保存。"""

    def __init__(self, user_id, binding_id: int):
        self._path = _cache_path(user_id, binding_id)
        self._entries: dict[str, list] = {}
        self._seen: set[str] = set()
        self._dirty = False
        try:
            loaded = json.loads(self._path.read_text())
            if isinstance(loaded, dict):
                self._entries = loaded
        except (OSError, ValueError):
            self._entries = {}

    def lookup(self, relative_path: str, path: Path) -> str | None:
        self._seen.add(relative_path)
        entry = self._entries.get(relative_path)
        if not isinstance(entry, list) or len(entry) != 3:
            return None
        try:
            stat = path.stat()
        except OSError:
            return None
        if entry[0] == stat.st_size and entry[1] == stat.st_mtime_ns:
            return str(entry[2])
        return None

    def store(self, relative_path: str, path: Path, fingerprint: str) -> None:
        try:
            stat = path.stat()
        except OSError:
            return
        self._seen.add(relative_path)
        entry = [stat.st_size, stat.st_mtime_ns, fingerprint]
        if self._entries.get(relative_path) != entry:
            self._entries[relative_path] = entry
            self._dirty = True

    def save(self, *, prune: bool = True) -> None:
        """写回缓存。整树 reconcile 用默认 prune=True 只留本轮见过的路径；
        单点投影只覆盖个别路径，必须 prune=False 保留全量条目。"""
        if prune:
            entries = {key: self._entries[key] for key in sorted(self._seen) if key in self._entries}
        else:
            entries = self._entries
        if not self._dirty and entries == self._entries:
            return
        self._entries = entries
        self._dirty = False
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".statcache-", dir=self._path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(self._entries, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
