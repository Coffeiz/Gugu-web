"""当前用户文件正文的轻量文本检索。

这是文件工具，不是 Shell 命令执行器：只按逐行字面量匹配，不解析管道、重定向
或命令替换。默认检索当前用户可访问的所有文件空间，显式 path 才收窄范围，
并始终按 user_id 隔离；命中后返回行号和有限上下文，正文精读仍交给 ``read_file``。
"""
from __future__ import annotations

import asyncio
from pathlib import PurePosixPath

from app.services.files.corpus import list_grep_candidates, resolve_grep_candidate_paths
from app.services.storage import get_storage

_SEARCH_SPACES = ("personal", "project", "workspace")
_MAX_QUERY_CHARS = 500
_MAX_CONTEXT_LINES = 20
_MAX_FILE_BYTES = 4 * 1024 * 1024
_DEFAULT_LIMIT = 50
_READ_CONCURRENCY = 8


def _normalise_path(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text.startswith("/") or "\\" in text or "\x00" in text:
        raise ValueError("path 必须是 /personal、/project 或 /workspace 下的逻辑路径")
    path = PurePosixPath(text)
    parts = path.parts
    if len(parts) < 2 or parts[0] != "/" or parts[1] not in _SEARCH_SPACES:
        raise ValueError("path 只允许 /personal、/project 或 /workspace")
    if any(part in {"", ".", ".."} for part in parts[2:]):
        raise ValueError("path 不能包含 . 或 ..")
    return "/" + "/".join(parts[1:])


def _path_is_under(path: str, prefix: str | None) -> bool:
    return prefix is None or path == prefix or path.startswith(prefix.rstrip("/") + "/")


def _parse_options(args: dict) -> tuple[str, str | None, int, int, bool]:
    query = str(args.get("query") or "")
    if not query.strip():
        raise ValueError("需要提供搜索关键词 query")
    if len(query) > _MAX_QUERY_CHARS:
        raise ValueError(f"query 不能超过 {_MAX_QUERY_CHARS} 个字符")
    if "\n" in query or "\r" in query:
        raise ValueError("query 只能搜索单行文本")
    path = _normalise_path(args.get("path"))
    try:
        context_lines = int(args.get("context_lines", 2))
        limit = int(args.get("limit", _DEFAULT_LIMIT))
    except (TypeError, ValueError) as exc:
        raise ValueError("context_lines 和 limit 必须是整数") from exc
    if context_lines < 0 or context_lines > _MAX_CONTEXT_LINES:
        raise ValueError(f"context_lines 必须在 0-{_MAX_CONTEXT_LINES} 之间")
    if limit < 1 or limit > 200:
        raise ValueError("limit 必须在 1-200 之间")
    case_sensitive = bool(args.get("case_sensitive", False))
    return query, path, context_lines, limit, case_sensitive


def _prepare_candidates(rows, logical_paths: dict[int, str | None], requested_path: str | None):
    from agent.tools.files import _is_text_file_record

    candidates: list[tuple[object, str]] = []
    scanned_files = skipped_files = 0
    for file in rows:
        if not _is_text_file_record(file):
            skipped_files += 1
            continue
        logical_path = logical_paths.get(file.id)
        if logical_path is None:
            continue
        if requested_path and not _path_is_under(logical_path, requested_path):
            continue

        scanned_files += 1
        if (file.size_bytes or 0) > _MAX_FILE_BYTES:
            skipped_files += 1
            continue
        candidates.append((file, logical_path))
    return candidates, scanned_files, skipped_files

async def _read_candidate_text(storage, file) -> str | None:
    try:
        return (await storage.get(file.storage_key)).decode("utf-8")
    except (UnicodeDecodeError, OSError, ValueError):
        return None
    except Exception:
        # 不把底层存储异常暴露给模型；本次检索继续扫描其它文件。
        return None


def _matching_lines(lines: list[str], needle: str, case_sensitive: bool, remaining: int) -> list[int]:
    """最多找出剩余预算 + 1 个命中，足以判断截断且避免收集整篇所有命中行。"""
    hits = []
    for index, line in enumerate(lines):
        searchable_line = line if case_sensitive else line.casefold()
        if needle in searchable_line:
            hits.append(index)
            if len(hits) > remaining:
                break
    return hits


def _format_result(file, logical_path: str, lines: list[str], hits: list[int], context_lines: int) -> dict:
    return {
        "file_id": file.id,
        "name": f"{file.display_name}.{file.ext}" if file.ext else file.display_name,
        "space": file.space,
        "path": logical_path,
        "project_id": file.project_id,
        "folder_id": file.folder_id,
        "workspace_directory_id": file.workspace_directory_id,
        "matches": [
            {
                "line": index + 1,
                "text": lines[index],
                "context": [
                    {"line": context_index + 1, "text": lines[context_index]}
                    for context_index in range(
                        max(0, index - context_lines),
                        min(len(lines), index + context_lines + 1),
                    )
                ],
            }
            for index in hits
        ],
    }


async def _scan_candidates(candidates, storage, needle, context_lines, limit, case_sensitive):
    grouped: list[dict] = []
    skipped_files = total_matches = 0
    truncated = False
    for offset in range(0, len(candidates), _READ_CONCURRENCY):
        batch = candidates[offset:offset + _READ_CONCURRENCY]
        texts = await asyncio.gather(*(
            _read_candidate_text(storage, file)
            for file, _ in batch
        ))
        for (file, logical_path), text in zip(batch, texts):
            if text is None:
                skipped_files += 1
                continue

            lines = text.splitlines()
            hits = _matching_lines(lines, needle, case_sensitive, limit - total_matches)
            if not hits:
                continue

            available = limit - total_matches
            selected_hits = hits[:available]
            total_matches += len(selected_hits)
            truncated = truncated or len(selected_hits) < len(hits)
            if not selected_hits:
                break

            grouped.append(_format_result(file, logical_path, lines, selected_hits, context_lines))
            if total_matches >= limit:
                break

        if total_matches >= limit:
            break

    return grouped, skipped_files, total_matches, truncated


async def _grep_files(db, user_id, args: dict):
    try:
        query, requested_path, context_lines, limit, case_sensitive = _parse_options(args)
    except ValueError as exc:
        return {"error": str(exc)}

    # 默认覆盖三个用户文件空间；显式 path 至少先在 SQL 层收窄到对应空间。
    spaces = (requested_path.split("/")[1],) if requested_path else _SEARCH_SPACES
    rows = await list_grep_candidates(db, user_id=user_id, spaces=spaces)
    logical_paths = await resolve_grep_candidate_paths(db, user_id=user_id, files=rows)
    candidates, scanned_files, skipped_files = _prepare_candidates(
        rows, logical_paths, requested_path,
    )
    needle = query if case_sensitive else query.casefold()
    grouped, read_skipped, total_matches, truncated = await _scan_candidates(
        candidates, get_storage(), needle, context_lines, limit, case_sensitive,
    )
    skipped_files += read_skipped

    return {
        "success": True,
        "query": query,
        "path": requested_path,
        "context_lines": context_lines,
        "scanned_files": scanned_files,
        "skipped_files": skipped_files,
        "matched_files": len(grouped),
        "total_matches": total_matches,
        "truncated": truncated,
        "results": grouped,
    }


__all__ = ["_grep_files"]
