"""对 Shell 逻辑目录提供只读 list_dir 访问。"""
from __future__ import annotations

import os
from pathlib import Path


_LOGICAL_ROOTS = {"personal", "project", "workspace"}
_MAX_DIRECTORY_PAGE = 200
_MAX_PATH_CHARS = 4096


async def _logical_root(db, user_id, namespace: str) -> Path | None:
    from app.services.workspaces import (
        resolve_project_root,
        resolve_user_personal_root,
        resolve_workspace_root,
    )

    if namespace == "personal":
        return await resolve_user_personal_root(db, user_id)
    if namespace == "project":
        return await resolve_project_root(db, user_id)

    # workspace 映射严格跟随当前 Agent 会话的绑定；未绑定时使用与 Shell
    # 相同的默认 Workspace，不允许用路径挑选其他用户工作区。
    from .locations import _bound_workspace_target

    target = await _bound_workspace_target(db, user_id)
    workspace_id = target.get("workspace_id") if isinstance(target, dict) else None
    if workspace_id is None:
        return None
    return await resolve_workspace_root(db, user_id, int(workspace_id))


def _parse_logical_path(raw: object) -> tuple[str | None, tuple[str, ...], str | None]:
    value = str(raw or "").strip()
    if not value or len(value) > _MAX_PATH_CHARS or "\x00" in value or "\\" in value:
        return None, (), "path 必须是 /personal、/project 或 /workspace 下的逻辑目录"
    if not value.startswith("/"):
        return None, (), "逻辑目录 path 必须以 /personal、/project 或 /workspace 开头"
    parts = value.split("/")[1:]
    if any(part in {".", ".."} for part in parts):
        return None, (), "逻辑目录 path 不允许 . 或 .. 路径段"
    parts = [part for part in parts if part]
    if not parts or parts[0] not in _LOGICAL_ROOTS:
        return None, (), "逻辑目录 path 仅支持 /personal、/project 或 /workspace"
    return parts[0], tuple(parts[1:]), None


async def list_logical_directory(db, user_id, args: dict) -> dict:
    """列出 Shell 映射的用户数据目录，不经过 system 文件权限入口。"""
    incompatible = (
        "space", "project_id", "workspace_directory_id", "folder", "folder_id", "parent_id",
        "queries", "mode",
    )
    if any(args.get(key) not in (None, "") for key in incompatible):
        return {"error": "scope=logical 只能使用 path、kind、query、ext、limit、offset 和 sort"}

    namespace, relative_parts, error = _parse_logical_path(args.get("path"))
    if error or namespace is None:
        return {"error": error or "逻辑目录 path 无效"}
    root = await _logical_root(db, user_id, namespace)
    if root is None:
        if namespace == "workspace":
            return {"error": "当前会话没有可映射的本地 Workspace"}
        return {"error": f"/{namespace} 当前没有可访问的本地目录"}

    try:
        root = root.resolve(strict=True)
        directory = root.joinpath(*relative_parts).resolve(strict=True)
        directory.relative_to(root)
        if not directory.is_dir():
            return {"error": "目标不是可访问的目录"}
    except (OSError, RuntimeError, ValueError):
        return {"error": "逻辑目录不存在或不可访问"}

    if args.get("sort") not in (None, "name"):
        return {"error": "逻辑目录只支持按名称排序"}
    try:
        limit = int(args.get("limit", 100))
        offset = int(args.get("offset", 0))
    except (TypeError, ValueError):
        return {"error": "limit 和 offset 必须是整数"}
    if limit < 1 or limit > _MAX_DIRECTORY_PAGE or offset < 0:
        return {"error": f"limit 必须在 1-{_MAX_DIRECTORY_PAGE}，offset 不能小于 0"}

    kind = args.get("kind") if args.get("kind") in {"both", "file", "folder"} else "both"
    query = str(args.get("query") or args.get("q") or "").strip().casefold()
    extension = str(args.get("ext") or "").strip().lower().lstrip(".")
    entries: list[dict] = []
    logical_parent = "/" + "/".join((namespace, *relative_parts))
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if query and query not in entry.name.casefold():
                    continue
                # 不跟随用户数据中的 symlink，避免通过逻辑根越界浏览其它目录。
                if entry.is_symlink():
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                logical_path = f"{logical_parent.rstrip('/')}/{entry.name}"
                if entry.is_dir(follow_symlinks=False):
                    if kind != "file":
                        entries.append({"name": entry.name, "path": logical_path, "kind": "folder"})
                elif entry.is_file(follow_symlinks=False):
                    entry_extension = Path(entry.name).suffix.lower().lstrip(".")
                    if kind == "folder" or (extension and entry_extension != extension):
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": logical_path,
                        "kind": "file",
                        "size_bytes": metadata.st_size,
                    })
    except OSError:
        return {"error": "无法读取目标逻辑目录"}

    entries.sort(key=lambda item: (item["name"].casefold(), item["name"], item["kind"]))
    page = entries[offset:offset + limit]
    return {
        "scope": "logical",
        "path": "/" + "/".join((namespace, *relative_parts)),
        "shown": len(page),
        "total": len(entries),
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(page) < len(entries),
        "files": [item for item in page if item["kind"] == "file"],
        "folders": [item for item in page if item["kind"] == "folder"],
    }
