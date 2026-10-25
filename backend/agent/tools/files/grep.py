"""当前用户文件正文的轻量文本检索。

这是文件工具，不是 Shell 命令执行器：只按逐行字面量匹配，不解析管道、重定向
或命令替换。默认检索当前用户可访问的所有文件空间，显式 path 才收窄范围，
并始终按 user_id 隔离；命中后返回行号和有限上下文，正文精读仍交给 ``read_file``。
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass

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
_DEFAULT_LIMIT = 50
_READ_CONCURRENCY = 8
_MAX_LINE_CHARS = 700
_MAX_RESULT_BYTES = 128 * 1024
_DATA_URI_RE = re.compile(r"data:[^,\s]+;base64,[A-Za-z0-9+/=_-]+", re.IGNORECASE)
_LINE_TRUNCATION_MARKER = "…[行内容已截断]…"
_DATA_URI_MARKER = "[内嵌Base64数据已省略]"


@dataclass(frozen=True)
class _FormatOptions:
    context_lines: int
    needle: str
    case_sensitive: bool


@dataclass(frozen=True)
class _CandidateInput:
    file: object
    logical_path: str
    text: str | None


@dataclass(frozen=True)
class _CandidateOutcome:
    skipped_files: int = 0
    matches: int = 0
    truncated: bool = False
    truncation_reasons: frozenset[str] = frozenset()
    stop: bool = False


def _normalise_path(value: str | None) -> str | None:
    return normalize_file_logical_path(value)


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


def _prepare_search_lines(text: str) -> tuple[list[str], bool]:
    """省略 SVG 等文本文件内嵌的 Base64 载荷，避免匹配和输出编码图片。"""
    original_lines = text.splitlines()
    lines = [_DATA_URI_RE.sub(_DATA_URI_MARKER, line) for line in original_lines]
    return lines, lines != original_lines


def _clip_line(line: str, needle: str | None = None, case_sensitive: bool = False) -> tuple[str, bool]:
    if len(line) <= _MAX_LINE_CHARS:
        return line, False

    marker = _LINE_TRUNCATION_MARKER
    content_budget = _MAX_LINE_CHARS - len(marker)
    if needle:
        searchable_line = line if case_sensitive else line.casefold()
        searchable_needle = needle if case_sensitive else needle.casefold()
        match_start = searchable_line.find(searchable_needle)
    else:
        match_start = 0
    if match_start < 0:
        match_start = 0

    start = max(0, match_start - max(0, (content_budget - len(needle or "")) // 2))
    end = min(len(line), start + content_budget)
    start = max(0, end - content_budget)
    prefix = "…" if start else ""
    suffix = "…" if end < len(line) else ""
    available = _MAX_LINE_CHARS - len(marker) - len(prefix) - len(suffix)
    snippet_start = max(0, min(start, len(line) - available))
    snippet_end = snippet_start + available
    return f"{prefix}{line[snippet_start:snippet_end]}{suffix}{marker}", True


def _format_result(
    file, logical_path: str, lines: list[str], hits: list[int], options: _FormatOptions,
) -> tuple[dict, bool]:
    clipped = False
    matches = []
    for index in hits:
        match_text, match_clipped = _clip_line(
            lines[index], options.needle, options.case_sensitive,
        )
        clipped = clipped or match_clipped
        context = []
        for context_index in range(
            max(0, index - options.context_lines),
            min(len(lines), index + options.context_lines + 1),
        ):
            context_text, context_clipped = _clip_line(lines[context_index])
            clipped = clipped or context_clipped
            context.append({"line": context_index + 1, "text": context_text})
        matches.append({"line": index + 1, "text": match_text, "context": context})

    return ({
        "file_id": file.id,
        "name": f"{file.display_name}.{file.ext}" if file.ext else file.display_name,
        "space": file.space,
        "path": logical_path,
        "project_id": file.project_id,
        "folder_id": file.folder_id,
        "workspace_directory_id": file.workspace_directory_id,
        "matches": matches,
    }, clipped)


def _fit_result_to_budget(grouped: list[dict], file_result: dict) -> tuple[int, bool]:
    original_match_count = len(file_result["matches"])
    while file_result["matches"]:
        candidate = [*grouped, file_result]
        encoded_size = len(json.dumps(candidate, ensure_ascii=False).encode("utf-8"))
        if encoded_size <= _MAX_RESULT_BYTES:
            break
        file_result["matches"].pop()
    retained = len(file_result["matches"])
    return retained, retained < original_match_count


def _append_candidate_result(
    grouped: list[dict], candidate: _CandidateInput, remaining: int, options: _FormatOptions,
) -> _CandidateOutcome:
    if candidate.text is None:
        return _CandidateOutcome(skipped_files=1)

    lines, omitted_data_uri = _prepare_search_lines(candidate.text)
    hits = _matching_lines(lines, options.needle, options.case_sensitive, remaining)
    if not hits:
        return _CandidateOutcome()

    reasons = set()
    if omitted_data_uri:
        reasons.add("embedded_data_uri")
    selected_hits = hits[:remaining]
    match_limited = len(selected_hits) < len(hits)
    if match_limited:
        reasons.add("match_limit")

    file_result, clipped = _format_result(
        candidate.file, candidate.logical_path, lines, selected_hits, options,
    )
    if clipped:
        reasons.add("line_length")
    retained, result_limited = _fit_result_to_budget(grouped, file_result)
    if result_limited:
        reasons.add("result_byte_limit")
    if retained:
        grouped.append(file_result)

    return _CandidateOutcome(
        matches=retained,
        truncated=omitted_data_uri or match_limited or clipped or result_limited,
        truncation_reasons=frozenset(reasons),
        stop=result_limited,
    )


async def _scan_candidates(candidates, storage, needle, context_lines, limit, case_sensitive):
    grouped: list[dict] = []
    skipped_files = total_matches = 0
    truncated = False
    truncation_reasons: set[str] = set()
    format_options = _FormatOptions(context_lines, needle, case_sensitive)
    for offset in range(0, len(candidates), _READ_CONCURRENCY):
        batch = candidates[offset:offset + _READ_CONCURRENCY]
        texts = await asyncio.gather(*(
            _read_candidate_text(storage, file)
            for file, _ in batch
        ))
        stop = False
        for (file, logical_path), text in zip(batch, texts):
            candidate = _CandidateInput(file, logical_path, text)
            outcome = _append_candidate_result(
                grouped, candidate, limit - total_matches, format_options,
            )
            skipped_files += outcome.skipped_files
            total_matches += outcome.matches
            truncated = truncated or outcome.truncated
            truncation_reasons.update(outcome.truncation_reasons)
            if outcome.stop or total_matches >= limit:
                stop = True
                break

        if stop:
            break

    return grouped, skipped_files, total_matches, truncated, truncation_reasons


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
    grouped, read_skipped, total_matches, truncated, truncation_reasons = await _scan_candidates(
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
        "truncation_reasons": sorted(truncation_reasons),
        "results": grouped,
    }


__all__ = ["_grep_files"]
