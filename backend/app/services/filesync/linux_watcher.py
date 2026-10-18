"""Linux 原生 inotify 协议进程：显式上报内核队列溢出，不读取文件正文。"""
from __future__ import annotations

import ctypes
from collections import Counter, deque
import json
import os
from pathlib import Path
import selectors
import struct
import sys

_CREATE, _DELETE, _MOVED_FROM, _MOVED_TO = 0x100, 0x200, 0x40, 0x80
_MODIFY, _ATTRIB, _CLOSE_WRITE = 2, 4, 8
_DELETE_SELF, _MOVE_SELF, _OVERFLOW, _IGNORED, _ISDIR = 0x400, 0x800, 0x4000, 0x8000, 0x40000000
_MASK = _CREATE | _DELETE | _MOVED_FROM | _MOVED_TO | _MODIFY | _ATTRIB | _CLOSE_WRITE | _DELETE_SELF | _MOVE_SELF


class NativeWatcher:
    def __init__(self):
        self.library = ctypes.CDLL(None, use_errno=True)
        self.library.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.fd = self.library.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "无法初始化 inotify")
        self.bindings: dict[int, tuple[Path, set[str] | None]] = {}
        self.watches: dict[int, dict[int, Path]] = {}
        self.entries: dict[int, dict[str, str]] = {}
        self.failed: set[int] = set()
        self.reported_gaps: set[tuple[int, str]] = set()
        self.pending: deque[tuple[int, Path, bool]] = deque()
        self.pending_counts: Counter[int] = Counter()
        self.initializing: set[int] = set()

    @staticmethod
    def emit(message: dict) -> None:
        print(json.dumps({"protocol": 1, **message}), flush=True)

    def event(self, binding_id: int, event: str, **fields) -> None:
        if event == "needs_reconcile":
            key = (binding_id, str(fields.get("code", "")))
            if key in self.reported_gaps:
                return
            self.reported_gaps.add(key)
        message = dict(fields)
        message.update(kind="event", event=event, binding_id=binding_id)
        self.emit(message)

    def accepted(self, binding_id: int, relative: str) -> bool:
        included = self.bindings[binding_id][1]
        parts = Path(relative).parts
        return bool(parts) and (not included or parts[0] in included) and not any(
            part.startswith(".gugu-sync-") or part.endswith((".gugu-part", ".gugu-tmp")) for part in parts
        )

    def change(self, binding_id: int, relative: str, operation: str, kind: str) -> None:
        entries = self.entries[binding_id]
        if operation == "delete":
            entries.pop(relative, None)
        else:
            entries[relative] = kind
        self.event(binding_id, "change", relative_path=relative, operation=operation, object_type=kind)

    def scan(self, binding_id: int, directory: Path, *, announce: bool) -> None:
        root = self.bindings[binding_id][0]
        try:
            opened = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError as exc:
            code = "watcher_permission_denied" if exc.errno in {1, 13} else "watcher_path_unavailable"
            self.event(binding_id, "needs_reconcile", code=code)
            return
        try:
            # 对已经打开的目录校验归属，防止扫描中目录被换成越界符号链接。
            actual = Path(f"/proc/self/fd/{opened}").resolve()
            actual.relative_to(root)
            descriptor = self.library.inotify_add_watch(self.fd, os.fsencode(f"/proc/self/fd/{opened}"), _MASK)
            if descriptor < 0:
                code = ctypes.get_errno()
                if code == 28:
                    self.failed.add(binding_id)
                    self.event(binding_id, "error", code="watcher_limit_exceeded")
                else:
                    self.event(binding_id, "needs_reconcile", code="watcher_permission_denied")
                return
            self.watches.setdefault(descriptor, {})[binding_id] = directory
            with os.scandir(opened) as iterator:
                children = list(iterator)
            self.scan_children(binding_id, directory, children, announce=announce)
        except (OSError, ValueError):
            self.event(binding_id, "needs_reconcile", code="watcher_path_unavailable")
        finally:
            os.close(opened)

    def scan_children(self, binding_id: int, directory: Path, children, *, announce: bool) -> None:
        root = self.bindings[binding_id][0]
        for child in children:
            path = directory / child.name
            relative = path.relative_to(root).as_posix()
            if not self.accepted(binding_id, relative) or child.is_symlink():
                continue
            kind = "folder" if child.is_dir(follow_symlinks=False) else "file" if child.is_file(follow_symlinks=False) else None
            if kind is None:
                continue
            is_new = relative not in self.entries[binding_id]
            self.entries[binding_id][relative] = kind
            if announce and is_new:
                self.change(binding_id, relative, "create", kind)
            if kind == "folder":
                self.queue_scan(binding_id, path, announce=announce)

    def queue_scan(self, binding_id: int, directory: Path, *, announce: bool) -> None:
        self.pending.append((binding_id, directory, announce))
        self.pending_counts[binding_id] += 1

    def scan_step(self) -> None:
        binding_id, directory, announce = self.pending.popleft()
        if binding_id not in self.failed:
            self.scan(binding_id, directory, announce=announce)
        self.pending_counts[binding_id] -= 1
        if self.pending_counts[binding_id] == 0 and binding_id in self.initializing:
            self.initializing.discard(binding_id)
            if binding_id not in self.failed:
                self.event(binding_id, "ready")

    def unwatch(self, binding_id: int) -> None:
        self.bindings.pop(binding_id, None)
        self.entries.pop(binding_id, None)
        self.failed.discard(binding_id)
        self.reported_gaps = {item for item in self.reported_gaps if item[0] != binding_id}
        self.initializing.discard(binding_id)
        self.pending_counts.pop(binding_id, None)
        self.pending = deque(item for item in self.pending if item[0] != binding_id)
        for descriptor, subscribers in list(self.watches.items()):
            subscribers.pop(binding_id, None)
            if not subscribers:
                self.watches.pop(descriptor)
                self.library.inotify_rm_watch(self.fd, descriptor)

    def watch(self, request: dict) -> None:
        binding_id = request["binding_id"]
        root = Path(request["root"]).absolute()
        scope = (root, set(request.get("included_root_entries") or []) or None)
        if self.bindings.get(binding_id) != scope:
            self.unwatch(binding_id)
            if not root.is_dir():
                self.event(binding_id, "error", code="watcher_scan_failed")
                return
            self.bindings[binding_id] = scope
            self.entries[binding_id] = {}
            self.initializing.add(binding_id)
            self.queue_scan(binding_id, root, announce=False)
        elif binding_id not in self.failed and binding_id not in self.initializing:
            self.event(binding_id, "ready")

    def path_event(self, binding_id: int, directory: Path, mask: int, name: str) -> None:
        root = self.bindings[binding_id][0]
        path = directory / name
        relative = path.relative_to(root).as_posix()
        if not self.accepted(binding_id, relative):
            return
        kind = "folder" if mask & _ISDIR else "file"
        if mask & (_DELETE | _MOVED_FROM):
            self.delete_path(binding_id, relative, kind)
        elif mask & (_CREATE | _MOVED_TO | _MODIFY | _ATTRIB | _CLOSE_WRITE):
            self.change_path(binding_id, path, relative, kind, mask)

    def delete_path(self, binding_id: int, relative: str, kind: str) -> None:
        self.change(binding_id, relative, "delete", kind)
        if kind != "folder":
            return
        self.release_tree(binding_id, self.bindings[binding_id][0] / relative)
        # 仅目录删除需要枚举后代；普通文件删除为直接查找。
        for tracked, tracked_kind in list(self.entries[binding_id].items()):
            if tracked.startswith(relative + "/"):
                self.change(binding_id, tracked, "delete", tracked_kind)

    def release_tree(self, binding_id: int, directory: Path) -> None:
        for descriptor, subscribers in list(self.watches.items()):
            watched = subscribers.get(binding_id)
            if watched is None or (watched != directory and directory not in watched.parents):
                continue
            subscribers.pop(binding_id)
            if not subscribers:
                self.watches.pop(descriptor)
                self.library.inotify_rm_watch(self.fd, descriptor)

    def change_path(self, binding_id: int, path: Path, relative: str, kind: str, mask: int) -> None:
        if path.is_symlink():
            if relative in self.entries[binding_id]:
                self.event(binding_id, "needs_reconcile", code="watcher_symlink_changed")
            return
        if not path.exists():
            return
        operation = "update" if relative in self.entries[binding_id] else "create"
        self.change(binding_id, relative, operation, kind)
        if kind == "folder" and mask & (_CREATE | _MOVED_TO):
            self.queue_scan(binding_id, path, announce=True)

    def drain(self) -> None:
        while True:
            try:
                data = os.read(self.fd, 1024 * 1024)
            except BlockingIOError:
                return
            if not data:
                return
            offset = 0
            while offset < len(data):
                descriptor, mask, _, size = struct.unpack_from("iIII", data, offset)
                name = os.fsdecode(data[offset + 16:offset + 16 + size].split(b"\0", 1)[0])
                offset += 16 + size
                self.dispatch(descriptor, mask, name)

    def dispatch(self, descriptor: int, mask: int, name: str) -> None:
        if mask & _OVERFLOW:
            self.emit({"kind": "event", "event": "needs_reconcile", "code": "kernel_event_queue_overflow"})
            return
        if mask & _IGNORED:
            self.watches.pop(descriptor, None)
            return
        for binding_id, directory in list(self.watches.get(descriptor, {}).items()):
            if not name:
                if mask & (_DELETE_SELF | _MOVE_SELF) and directory == self.bindings[binding_id][0]:
                    self.event(binding_id, "error", code="watcher_root_changed")
                continue
            self.path_event(binding_id, directory, mask, name)


def respond(watcher: NativeWatcher, line: bytes) -> bool:
    request = {}
    try:
        payload = json.loads(line)
        if not isinstance(payload, dict):
            raise ValueError("监听命令必须为对象")
        request = payload
        if request.get("protocol") != 1:
            raise ValueError("监听协议版本不匹配")
        operation = request.get("op")
        if operation == "watch":
            watcher.watch(request)
        elif operation == "unwatch":
            watcher.unwatch(request["binding_id"])
        elif operation == "refresh":
            watcher.emit({"kind": "event", "event": "needs_reconcile", "code": "requested"})
        elif operation not in {"ping", "shutdown"}:
            raise ValueError("未知监听命令")
        watcher.emit({"kind": "response", "id": request.get("id"), "status": "ok"})
        return operation == "shutdown"
    except (OSError, ValueError, KeyError):
        watcher.emit({"kind": "response", "id": request.get("id"), "status": "error", "code": "watcher_failure"})
        return False


def main() -> None:
    watcher = NativeWatcher()
    selector = selectors.DefaultSelector()
    selector.register(watcher.fd, selectors.EVENT_READ, "events")
    selector.register(sys.stdin.fileno(), selectors.EVENT_READ, "commands")
    buffered = b""
    try:
        while True:
            ready = selector.select(timeout=0 if watcher.pending else None)
            for key, _ in ready:
                if key.data == "events":
                    watcher.drain()
                    continue
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    return
                buffered += chunk
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    if respond(watcher, line):
                        return
            if watcher.pending:
                watcher.scan_step()
    finally:
        selector.close()
        os.close(watcher.fd)


if __name__ == "__main__":
    main()
