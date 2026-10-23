"""Agent 文件工具对 system 范围的只读访问。"""
from __future__ import annotations

import os
import stat
from pathlib import Path

from agent.tools.base import (
    current_dispatch_filesystem_subject,
    current_dispatch_session,
    current_dispatch_session_id,
)
from agent.tools.text_edit import select_numbered_lines

_MAX_DIRECTORY_PAGE = 200
_MAX_PATH_CHARS = 4096


async def _system_read_denial(db, user_id) -> str | None:
    """复用 Shell 的 system 范围判定，并拒绝后台主体和非所有者群聊身份。"""
    from agent.im import imctx
    from agent.security.shell_policy import ShellScope, evaluate

    current_im = imctx.get_im()
    if current_im and current_im.get("im_role") != "owner":
        return "群聊成员和未识别身份不能读取 system 范围文件"

    subject = current_dispatch_filesystem_subject() or {}
    subject_type = str(subject.get("subject_type") or "session")
    if subject_type != "session":
        return "system 范围文件读取只允许交互会话使用"
    session_id = current_dispatch_session_id()
    if session_id is None:
        return "system 范围文件读取需要当前交互会话"

    decision = await evaluate(
        db,
        user_id,
        session_id,
        "pwd",
        session=current_dispatch_session(),
        requested_scope=ShellScope.SYSTEM,
        subject_type=subject_type,
        subject_id=subject.get("subject_id"),
    )
    return None if decision.allowed and not decision.needs_confirmation else decision.reason


def _resolve_system_path(value, *, directory: bool) -> tuple[Path | None, str | None]:
    raw = str(value or "").strip()
    if not raw or len(raw) > _MAX_PATH_CHARS or "\x00" in raw:
        return None, "path 必须是有效的绝对系统路径"
    try:
        path = Path(raw).expanduser()
        if not path.is_absolute():
            return None, "system 范围的 path 必须是绝对路径"
        resolved = path.resolve(strict=True)
        if directory and not resolved.is_dir():
            return None, "目标不是可访问的目录"
        if not directory and not resolved.exists():
            return None, "目标文件不存在或不可访问"
        return resolved, None
    except (OSError, RuntimeError, ValueError):
        return None, "目标路径不存在或不可访问"


async def list_system_directory(db, user_id, args: dict) -> dict:
    denial = await _system_read_denial(db, user_id)
    if denial:
        return {"error": denial}

    incompatible = (
        "space", "project_id", "workspace_directory_id", "folder", "folder_id", "parent_id",
        "queries", "mode",
    )
    if any(args.get(key) not in (None, "") for key in incompatible):
        return {"error": "scope=system 只能使用 path、kind、query、ext、limit 和 offset"}
    if args.get("sort") not in (None, "name"):
        return {"error": "system 目录只支持按名称排序"}

    directory, error = _resolve_system_path(args.get("path"), directory=True)
    if error:
        return {"error": error}

    kind = args.get("kind") if args.get("kind") in {"both", "file", "folder"} else "both"
    query = str(args.get("query") or args.get("q") or "").strip().casefold()
    extension = str(args.get("ext") or "").strip().lower().lstrip(".")
    try:
        limit = int(args.get("limit", 100))
        offset = int(args.get("offset", 0))
    except (TypeError, ValueError):
        return {"error": "limit 和 offset 必须是整数"}
    if limit < 1 or limit > _MAX_DIRECTORY_PAGE or offset < 0:
        return {"error": f"limit 必须在 1-{_MAX_DIRECTORY_PAGE}，offset 不能小于 0"}

    entries: list[dict] = []
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if query and query not in entry.name.casefold():
                    continue
                try:
                    resolved_entry = Path(entry.path).resolve(strict=True)
                    metadata = resolved_entry.stat()
                except (OSError, RuntimeError, ValueError):
                    continue
                if stat.S_ISDIR(metadata.st_mode):
                    if kind == "file":
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": entry.path,
                        "kind": "folder",
                    })
                elif stat.S_ISREG(metadata.st_mode):
                    if kind == "folder":
                        continue
                    entry_extension = resolved_entry.suffix.lower().lstrip(".")
                    if extension and entry_extension != extension:
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": entry.path,
                        "kind": "file",
                        "size_bytes": metadata.st_size,
                    })
    except OSError:
        return {"error": "无法读取目标目录"}

    entries.sort(key=lambda item: (item["name"].casefold(), item["name"]))
    page = entries[offset:offset + limit]
    files = [item for item in page if item["kind"] == "file"]
    folders = [item for item in page if item["kind"] == "folder"]
    return {
        "scope": "system",
        "path": str(directory),
        "shown": len(page),
        "total": len(entries),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(page) < len(entries),
        "files": files,
        "folders": folders,
    }


async def read_system_file(
    db, user_id, args: dict, *, max_source_bytes: int | None = None,
) -> dict | str:
    denial = await _system_read_denial(db, user_id)
    if denial:
        return {"error": denial}

    path, error = _resolve_system_path(args.get("path"), directory=False)
    if error:
        return {"error": error}

    from agent.tools.media_reader import MEDIA_EXTS, read_local_media

    extension = path.suffix.lower().lstrip(".")
    if extension in MEDIA_EXTS:
        result = await read_local_media(
            path, db=db, user_id=user_id, max_source_bytes=max_source_bytes,
        )
        return result

    from app.core import doctext
    from .file_operations import READ_MAX_BYTES

    is_document = extension in doctext.EXTRACTABLE
    byte_limit = doctext.EXTRACT_MAX_BYTES if is_document else READ_MAX_BYTES
    limit_mib = byte_limit // (1024 * 1024)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                return {"error": "只支持读取普通文件，不读取设备、管道或套接字"}
            if metadata.st_size > byte_limit:
                return {"error": f"文件过大，system 范围读取上限为 {limit_mib} MiB"}
            if max_source_bytes is not None and metadata.st_size > max_source_bytes:
                return {"error": "本批次剩余容量不足，未读取该文件"}
            data = source.read(byte_limit + 1)
    except OSError:
        return {"error": "文件不存在或不可读取"}
    if len(data) > byte_limit:
        return {"error": f"文件超过 system 范围读取上限（{limit_mib} MiB）"}

    try:
        if is_document:
            text = await doctext.extract_text(data, extension)
        else:
            text = data.decode("utf-8-sig")
            if any(
                (ord(char) < 32 and char not in "\n\r\t\f") or 0x7f <= ord(char) <= 0x9f
                for char in text
            ):
                return {"error": "system 范围只支持读取 UTF-8 文本和可提取文档"}
            # 与文件库 read_file 保持一致，避免大文本一次性占满工具结果和上下文。
            text = text[:doctext.MAX_CHARS]
    except (UnicodeDecodeError, RuntimeError, ValueError, OSError):
        return {"error": "文件内容无法按 UTF-8 文本或支持的文档格式读取"}

    try:
        content, numbered_content, selected_range = select_numbered_lines(
            text, args.get("target_lines", "all"),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    return {
        "scope": "system",
        "path": str(path),
        "name": path.name,
        "content": content,
        "numbered_content": numbered_content,
        "line_range": {"start": selected_range[0], "end": selected_range[1]},
        "_source_size_bytes": len(data),
    }
