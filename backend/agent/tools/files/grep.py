"""当前用户文件正文的轻量文本检索。

这是文件工具，不是 Shell 命令执行器：只按逐行字面量匹配，不解析管道、重定向
或命令替换。默认检索当前用户可访问的所有文件空间，显式 path 才收窄范围，
并始终按 user_id 隔离；命中后返回行号和有限上下文，正文精读仍交给 ``read_file``。
"""
from __future__ import annotations

from pathlib import PurePosixPath

from app.core.ownership import get_owned
from app.models import Project, WorkspaceDirectory
from app.services.files.corpus import list_grep_candidates
from app.services.storage import get_storage
from app.services.storage.folders import resolve_folder_path

_SEARCH_SPACES = ("personal", "project", "workspace")
_MAX_QUERY_CHARS = 500
_MAX_CONTEXT_LINES = 20
_MAX_FILE_BYTES = 4 * 1024 * 1024
_DEFAULT_LIMIT = 50


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


def _safe_component(value: object) -> str:
    return str(value or "").replace("/", "_").replace("\\", "_").strip()


async def _logical_path(
    db,
    user_id,
    *,
    space: str,
    project_id: int | None = None,
    folder_id: int | None = None,
    workspace_directory_id: int | None = None,
    file_name: str | None = None,
) -> str | None:
    """把 File 元数据映射成不含用户绝对路径的逻辑路径。"""
    if space == "personal":
        parts = ["personal"]
    elif space == "project":
        project = await get_owned(db, Project, project_id, user_id)
        if project is None:
            return None
        parts = ["project", _safe_component(project.name)]
    elif space == "workspace":
        directory = await get_owned(db, WorkspaceDirectory, workspace_directory_id, user_id)
        if directory is None or directory.deleted_at is not None:
            return None
        parts = ["workspace", _safe_component(directory.directory_name)]
    else:
        return None

    if folder_id is not None:
        resolved = await resolve_folder_path(
            db,
            user_id,
            folder_id,
            project_id if space == "project" else None,
            workspace_directory_id if space == "workspace" else None,
        )
        if resolved is None:
            return None
        _, folder_path = resolved
        parts.extend(_safe_component(part) for part in folder_path.split("/") if part)
    if file_name:
        parts.append(_safe_component(file_name))
    return "/" + "/".join(parts)


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


async def _grep_files(db, user_id, args: dict):
    try:
        query, requested_path, context_lines, limit, case_sensitive = _parse_options(args)
    except ValueError as exc:
        return {"error": str(exc)}

    # 只读检索默认覆盖当前用户所有可访问空间；Workspace 是写入默认落点，
    # 不是文件库查询的隐式目录。需要收窄范围时使用显式 path。
    from agent.tools.files import _is_text_file_record

    scope_prefix = None

    rows = await list_grep_candidates(db, user_id=user_id, spaces=_SEARCH_SPACES)

    needle = query if case_sensitive else query.casefold()
    storage = get_storage()
    scanned_files = 0
    skipped_files = 0
    total_matches = 0
    truncated = False
    grouped: list[dict] = []

    for file in rows:
        if not _is_text_file_record(file):
            skipped_files += 1
            continue
        logical_path = await _logical_path(
            db,
            user_id,
            space=file.space,
            project_id=file.project_id,
            folder_id=file.folder_id,
            workspace_directory_id=file.workspace_directory_id,
            file_name=f"{file.display_name}.{file.ext}" if file.ext else file.display_name,
        )
        if logical_path is None or not _path_is_under(logical_path, scope_prefix):
            continue
        if requested_path and not _path_is_under(logical_path, requested_path):
            continue

        scanned_files += 1
        if (file.size_bytes or 0) > _MAX_FILE_BYTES:
            skipped_files += 1
            continue
        try:
            text = (await storage.get(file.storage_key)).decode("utf-8")
        except (UnicodeDecodeError, OSError, ValueError):
            skipped_files += 1
            continue
        except Exception:
            # 不把底层存储异常暴露给模型；本次检索继续扫描其它文件。
            skipped_files += 1
            continue

        lines = text.splitlines()
        haystack = lines if case_sensitive else [line.casefold() for line in lines]
        hits = [index for index, line in enumerate(haystack) if needle in line]
        if not hits:
            continue

        available = max(0, limit - total_matches)
        selected_hits = hits[:available]
        total_matches += len(selected_hits)
        if len(selected_hits) < len(hits):
            truncated = True
        if not selected_hits:
            truncated = True
            break

        grouped.append({
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
                for index in selected_hits
            ],
        })
        if total_matches >= limit:
            truncated = truncated or len(hits) > len(selected_hits)
            break

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
