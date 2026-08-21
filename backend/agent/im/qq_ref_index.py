"""QQ 引用消息索引。

QQ 引用事件通常只携带 ref_msg_idx，正文和附件需要从此前收到的消息中恢复。
索引按网关进程所属 bot 隔离，内存读取优先，JSONL 用于重启恢复。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any


_TTL_SECONDS = 7 * 24 * 60 * 60
_MAX_ENTRIES = 50_000
_COMPACT_LINES = 1_000


def _safe_component(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)[:120] or "unknown"


class QQRefIndex:
    def __init__(self, *, owner: str, bot_id: str) -> None:
        root = Path(os.environ.get("QQ_REF_INDEX_DIR", "data/qq-ref-index"))
        self._path = root / f"{_safe_component(owner)}-{_safe_component(bot_id)}.jsonl"
        self._entries: dict[str, dict[str, Any]] = {}
        self._loaded = False
        self._line_count = 0

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            lines = self._path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return
        now = time.time()
        self._line_count = len(lines)
        for line in lines:
            try:
                item = json.loads(line)
                if item.get("t", 0) + _TTL_SECONDS >= now and item.get("k") and item.get("v"):
                    self._entries[str(item["k"])] = item["v"]
            except (ValueError, TypeError):
                continue
        self._evict()

    def get(self, key: str) -> dict[str, Any] | None:
        self._load()
        entry = self._entries.get(key)
        if entry is None:
            return None
        if float(entry.get("_stored_at", 0)) + _TTL_SECONDS < time.time():
            self._entries.pop(key, None)
            return None
        return dict(entry)

    def set(self, key: str, value: dict[str, Any]) -> None:
        self._load()
        stored = dict(value)
        stored["_stored_at"] = time.time()
        self._entries[key] = stored
        self._evict()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"k": key, "v": stored, "t": stored["_stored_at"]}, ensure_ascii=False) + "\n")
            self._line_count += 1
            if self._line_count > max(_COMPACT_LINES, len(self._entries) * 2):
                self._compact()
        except OSError:
            # 引用索引是增强能力，磁盘不可写时保留内存行为，不阻断消息入队。
            return

    def _evict(self) -> None:
        now = time.time()
        expired = [key for key, value in self._entries.items() if float(value.get("_stored_at", 0)) + _TTL_SECONDS < now]
        for key in expired:
            self._entries.pop(key, None)
        if len(self._entries) > _MAX_ENTRIES:
            ordered = sorted(self._entries.items(), key=lambda item: float(item[1].get("_stored_at", 0)))
            for key, _ in ordered[: len(self._entries) - _MAX_ENTRIES]:
                self._entries.pop(key, None)

    def _compact(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            now = time.time()
            with tmp.open("w", encoding="utf-8") as handle:
                for key, value in self._entries.items():
                    handle.write(json.dumps({"k": key, "v": value, "t": now}, ensure_ascii=False) + "\n")
            tmp.replace(self._path)
            self._line_count = len(self._entries)
        except OSError:
            return


def ref_index_key(chat_type: str, chat_id: str, sender_id: str, msg_idx: str) -> str:
    scope = chat_id or sender_id
    return f"{chat_type}:{scope}:{msg_idx}"
