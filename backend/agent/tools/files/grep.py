"""当前用户文件正文的轻量文本检索。

这是文件工具，不是 Shell 命令执行器：只按逐行字面量匹配，不解析管道、重定向
或命令替换。默认检索当前用户可访问的所有文件空间，显式 path 才收窄范围，
并始终按 user_id 隔离；命中后返回行号和有限上下文，正文精读仍交给 ``read_file``。
"""
from __future__ import annotations

import asyncio
import codecs

from app.services.files.corpus import (
    list_grep_candidates,
    normalize_file_logical_path,
    resolve_grep_candidate_paths,
)
from app.services.storage import get_storage

_SEARCH_SPACES = ("personal", "project", "workspace")
_MAX_QUERY_CHARS = 500
_MAX_CONTEXT_LINES = 20
_MAX_FILE_BYTES = 4 * 1024 * 1024
_STREAM_THRESHOLD_BYTES = 1024 * 1024
_DEFAULT_LIMIT = 50
_READ_CONCURRENCY = 64
_CJK_IDEOGRAPH_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
    (0x30000, 0x323AF),
)


def _normalise_path(value: str | None) -> str | None:
    return normalize_file_logical_path(value)


def _path_is_under(path: str, prefix: str | None) -> bool:
    return prefix is None or path == prefix or path.startswith(prefix.rstrip("/") + "/")


def _is_casefold_safe_ideograph_query(needle: str) -> bool:
    """识别不会被 Unicode 大小写折叠改变的汉字查询。"""
    return bool(needle) and all(
        any(start <= ord(char) <= end for start, end in _CJK_IDEOGRAPH_RANGES)
        for char in needle
    )


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

async def _iter_candidate_lines(storage, file):
    """按 UTF-8 增量解码并保留 ``str.splitlines()`` 的分隔符语义。"""
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending = ""
    line_endings = ("\r\n", "\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029")

    def emit_complete_lines(text: str, *, final: bool):
        pieces = text.splitlines(keepends=True)
        if not pieces:
            return [], ""
        incomplete = ""
        if not final:
            last = pieces[-1]
            # A trailing CR may pair with LF in the next byte chunk.
            if not last.endswith(line_endings) or last.endswith("\r"):
                incomplete = pieces.pop()
        lines = []
        for piece in pieces:
            for ending in line_endings:
                if piece.endswith(ending):
                    piece = piece[:-len(ending)]
                    break
            lines.append(piece)
        return lines, incomplete

    async for chunk in storage.iter_chunks(file.storage_key, chunk_size=64 * 1024):
        decoded = decoder.decode(chunk)
        lines, pending = emit_complete_lines(pending + decoded, final=False)
        for line in lines:
            yield line

    tail = decoder.decode(b"", final=True)
    lines, pending = emit_complete_lines(pending + tail, final=True)
    for line in lines:
        yield line
    if pending:
        yield pending


def _make_line_matches(
    lines, needle, context_lines, limit, case_sensitive, *, ideograph_query=False,
):
    hit_indices = []
    extra_hit = False
    for index, line in enumerate(lines):
        searchable_line = line if case_sensitive or ideograph_query else line.casefold()
        if needle in searchable_line:
            if len(hit_indices) >= limit:
                extra_hit = True
                break
            hit_indices.append(index)
    matches = [
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
        for index in hit_indices
    ]
    return matches, extra_hit


async def _scan_buffered_candidate(storage, file, needle, context_lines, limit, case_sensitive):
    ideograph_query = not case_sensitive and _is_casefold_safe_ideograph_query(needle)
    try:
        raw_needle = needle.encode("utf-8") if case_sensitive or ideograph_query else None
    except UnicodeEncodeError:
        raw_needle = None
    try:
        data = await storage.get(file.storage_key)
        raw_hit = raw_needle in data if raw_needle is not None else True
        text = data.decode("utf-8")
    except (UnicodeDecodeError, OSError, ValueError):
        return None
    except Exception:
        # 不把底层存储异常暴露给模型；本次检索继续扫描其它文件。
        return None
    if not raw_hit:
        return [], False
    return _make_line_matches(
        text.splitlines(), needle, context_lines, limit, case_sensitive,
        ideograph_query=ideograph_query,
    )


async def _scan_stream_candidate(storage, file, needle, context_lines, limit, case_sensitive):
    ideograph_query = not case_sensitive and _is_casefold_safe_ideograph_query(needle)
    matches: list[dict] = []
    preceding: list[tuple[int, str]] = []
    last_selected_line = -1
    extra_hit = False
    line_index = 0
    try:
        async for line in _iter_candidate_lines(storage, file):
            line_index += 1
            for match in matches:
                if match["line"] < line_index <= match["line"] + context_lines:
                    match["context"].append({"line": line_index, "text": line})

            searchable_line = line if case_sensitive or ideograph_query else line.casefold()
            if needle in searchable_line:
                if len(matches) >= limit:
                    extra_hit = True
                else:
                    preceding_rows = [
                        {"line": index, "text": text}
                        for index, text in preceding
                        if index >= line_index - context_lines
                    ]
                    matches.append({
                        "line": line_index,
                        "text": line,
                        "context": preceding_rows + [{"line": line_index, "text": line}],
                    })
                    last_selected_line = line_index

            if context_lines:
                preceding.append((line_index, line))
                if len(preceding) > context_lines:
                    preceding.pop(0)

            if extra_hit and line_index >= last_selected_line + context_lines:
                break
    except (UnicodeDecodeError, OSError, ValueError):
        return None
    except Exception:
        # 不把底层存储异常暴露给模型；本次检索继续扫描其它文件。
        return None
    return matches, extra_hit


async def _scan_one_candidate(storage, file, needle, context_lines, limit, case_sensitive):
    if (file.size_bytes or 0) <= _STREAM_THRESHOLD_BYTES:
        return await _scan_buffered_candidate(
            storage, file, needle, context_lines, limit, case_sensitive,
        )
    return await _scan_stream_candidate(storage, file, needle, context_lines, limit, case_sensitive)


async def _scan_candidates(candidates, storage, needle, context_lines, limit, case_sensitive):
    grouped: list[dict] = []
    skipped_files = total_matches = 0
    truncated = False
    for offset in range(0, len(candidates), _READ_CONCURRENCY):
        batch = candidates[offset:offset + _READ_CONCURRENCY]
        results = await asyncio.gather(*(
            _scan_one_candidate(storage, file, needle, context_lines, limit, case_sensitive)
            for file, _ in batch
        ))
        for (file, logical_path), scan_result in zip(batch, results):
            if scan_result is None:
                skipped_files += 1
                continue
            matches, extra_hit = scan_result
            available = limit - total_matches
            selected_matches = matches[:available]
            total_matches += len(selected_matches)
            truncated = truncated or len(selected_matches) < len(matches) or extra_hit
            if selected_matches:
                grouped.append({
                    "file_id": file.id,
                    "name": f"{file.display_name}.{file.ext}" if file.ext else file.display_name,
                    "space": file.space,
                    "path": logical_path,
                    "project_id": file.project_id,
                    "folder_id": file.folder_id,
                    "workspace_directory_id": file.workspace_directory_id,
                    "matches": selected_matches,
                })
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
    rows = await list_grep_candidates(
        db, user_id=user_id, spaces=spaces, requested_path=requested_path,
    )
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
