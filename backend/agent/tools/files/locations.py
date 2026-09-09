"""文件工具的空间、工作区和文件位置解析。"""

from __future__ import annotations

import json

from app.services.files.browser import (
    find_user_files_by_name,
    find_user_folders_by_name,
    get_user_file,
    get_user_folder,
    list_user_folders,
)
from app.services.filesystem_authorization import FilesystemPolicy, filesystem_location_can_write
from app.services.projects import get_user_project
from app.services.storage.folders import resolve_folder_path
from app.services.storage.keys import _build_key
from agent.tools.base import current_dispatch_session
from agent.tools.filesystem_policy import current_filesystem_policy, current_workspace_target

# ── 内部：按目标解析 storage_key（复刻 update_file/copy_file）──
async def _resolve_key(db, user_id, space, display_name, ext,
                       project_id=None, folder_id=None):
    project_name = project_year = project_month = folder_path = ""
    if space == "project" and project_id:
        p = await get_user_project(db, user_id, project_id)
        if not p:
            raise ValueError("目标项目不存在")
        project_name = p.name
        date_str = p.start_date or p.created_at.strftime("%Y-%m-%d")
        project_year, project_month = date_str[:4], date_str[5:7]
    if folder_id:
        resolved = await resolve_folder_path(
            db, user_id, folder_id, project_id if space == "project" else None,
        )
        if not resolved:
            raise ValueError("目标文件夹不存在，或不属于指定的项目/个人空间")
        _, folder_path = resolved
    key = _build_key(
        uid=user_id, space=space, display_name=display_name, ext=ext,
        project_name=project_name, project_id=project_id or 0,
        project_year=project_year, project_month=project_month,
        folder_path=folder_path,
    )
    return key


async def _location_receipt(db, user_id, space, project_id, folder_id):
    """保存/创建后的真实落点，完整路径供模型照回执转告，不再猜目录。"""
    project_name = None
    if space == "project" and project_id:
        project = await get_user_project(db, user_id, project_id)
        project_name = project.name if project else None
    folder_path = "（根目录）"
    if folder_id:
        resolved = await resolve_folder_path(
            db, user_id, folder_id, project_id if space == "project" else None,
        )
        if resolved:
            _, folder_path = resolved
    return {
        "space": space,
        "project_id": project_id if space == "project" else None,
        "project_name": project_name,
        "folder_id": folder_id,
        "folder_path": folder_path,
    }


def _coerce_loc(space, project_id, folder_id):
    """归一 move/copy 的目标位置，返回 (space, project_id, folder_id, error_json|None)。
    ① id 字符串转 int —— LLM 常把 "91" 当字符串传，int4 列拿到字符串会让 asyncpg 直接抛错。
    ② 落到「项目空间」却没指定具体项目 → 报错，挡住 space=project 但 project_id=None 的孤儿文件
       （在任何项目里都看不到、却占着"项目空间"，正是之前让人困惑的状态）。"""
    def _as_int(v):
        try:
            return int(str(v).strip().lstrip("#")) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None   # 解析不出（如把项目名当 id 传进来）→ None，别回原串：否则非数字会流进整数主键查询 → asyncpg DataError 崩
    project_id = _as_int(project_id)
    folder_id = _as_int(folder_id)
    if space == "project" and not project_id:
        return space, project_id, folder_id, json.dumps(
            {"error": "移动/复制到项目空间必须指定 target.project_id（具体哪个项目）。"
                      "可先用 list_projects 拿到项目 id 再操作。"})
    return space, project_id, folder_id, None


def _norm_target(target):
    """target 容错：模型偶尔把它序列化成字符串（JSON 或 Python 字面量），统一回 dict。"""
    if isinstance(target, dict):
        return target
    if isinstance(target, str) and target.strip():
        import ast
        for _p in (json.loads, ast.literal_eval):
            try:
                v = _p(target)
                if isinstance(v, dict):
                    return v
            except Exception:
                pass
    return {}


def _target_loc(f, target: dict):
    """据 target 算出 (space, project_id, folder_id, workspace_directory_id)。关键：跨项目/空间又没显式指定 folder 时，
    folder_id 落到目标根目录（None），**不继承源文件夹**——否则「复制到别的项目」会落回原文件夹
    （源文件夹属于原项目），表现为「原地复制了一份」。给了 project_id 没给 space 则视为进项目空间。"""
    def _i(v):
        try:
            return int(str(v).strip().lstrip("#")) if v not in (None, "") else None
        except (ValueError, TypeError):
            return None   # 同 _as_int：非数字（项目名误当 id）→ None，别让它流进整数查询崩
    if "space" in target:
        space = target["space"]
    elif target.get("project_id") not in (None, ""):
        space = "project"
    else:
        space = f.space
    project_id = _i(target.get("project_id", f.project_id))
    if "workspace_directory_id" in target:
        workspace_directory_id = _i(target.get("workspace_directory_id"))
    elif space == f.space and project_id == f.project_id:
        workspace_directory_id = f.workspace_directory_id
    else:
        workspace_directory_id = None
    if "folder_id" in target:
        folder_id = _i(target.get("folder_id"))
    elif space == f.space and project_id == f.project_id:
        folder_id = f.folder_id          # 同项目同空间内复制/移动 → 默认留在原文件夹
    else:
        folder_id = None                 # 跨项目/空间 → 落目标根目录，不继承源文件夹
    return space, project_id, folder_id, workspace_directory_id


async def _bound_workspace_target(db, user_id):
    """返回当前工具调用所属会话的文件库落点。

    未绑定的真实 Agent 会话使用用户默认 Workspace；没有 dispatch 上下文的
    直接 handler 调用仍返回 None，保持内部服务和单元测试的原有语义。
    """
    policy = await current_filesystem_policy(db, user_id)
    if policy is not None:
        # 完整用户沙箱只扩大显式 personal/project 的写权限，不能把已绑定
        # Workspace 的默认文件落点降级回源文件所在的 personal 空间。
        if policy.workspace_id is not None:
            return await current_workspace_target(db, user_id, policy)
        from app.services.workspaces import resolve_default_workspace_target
        return await resolve_default_workspace_target(db, user_id)
    if current_dispatch_session() is None:
        return None
    from app.services.workspaces import resolve_default_workspace_target
    return await resolve_default_workspace_target(db, user_id)


def _workspace_location(target: dict) -> tuple[str, int | None, int | None, int | None]:
    return target["space"], target.get("project_id"), target.get("folder_id"), target.get("workspace_directory_id")


async def _location_matches(db, user_id, space, project_id, folder_id, target: dict) -> bool:
    """复用统一 workspace 权限，允许根目录下的子文件夹。"""
    policy = await current_filesystem_policy(db, user_id)
    # 直接调用 handler 的测试没有 dispatch policy；不同主体的 workspace
    # 也不能复用当前 policy。真实完整授权则保留其跨 personal/project 的
    # 写权限，但默认落点仍由 target 指定的 workspace 决定。
    if policy is None or (
        not policy.full_user_sandbox
        and policy.workspace_id != target["workspace_id"]
    ):
        policy = FilesystemPolicy(workspace_id=target["workspace_id"])
    return await filesystem_location_can_write(
        db,
        user_id,
        policy,
        space=space,
        project_id=project_id,
        folder_id=folder_id,
    )


def _workspace_conflict(target: dict) -> str:
    location = target.get("workspace_name") or f"工作区 {target['workspace_id']}"
    return json.dumps({
        "error": f"当前会话已绑定工作区「{location}」，不能写入其它项目或文件夹。",
        "workspace_id": target["workspace_id"],
        "expected": {k: target.get(k) for k in ("space", "project_id", "folder_id")},
        "hint": "省略目标位置参数即可使用当前工作区；workspace_id 不能当作 project_id 使用。",
    }, ensure_ascii=False)


async def _resolve_create_location(db, user_id, args: dict):
    target = await _bound_workspace_target(db, user_id)
    explicit = any(args.get(key) not in (None, "") for key in ("space", "project_id", "folder_id"))
    if target is not None:
        if not explicit:
            return (*_workspace_location(target), None)
        # folder_id 本身足以确定空间；不要因为模型省略 space/project_id 而把项目文件夹误判为 personal。
        explicit_folder_id = args.get("folder_id")
        if explicit_folder_id not in (None, "") and args.get("space") in (None, "") and args.get("project_id") in (None, ""):
            try:
                folder = await get_user_folder(db, user_id, int(explicit_folder_id))
            except (TypeError, ValueError):
                folder = None
            if folder is not None:
                inferred_space = "project" if folder.project_id is not None else "personal"
                if await _location_matches(
                    db, user_id, inferred_space, folder.project_id, folder.id, target,
                ):
                    return inferred_space, folder.project_id, folder.id, None
        space, project_id, folder_id, error = _coerce_loc(
            args.get("space") or ("project" if args.get("project_id") else "personal"),
            args.get("project_id"), args.get("folder_id"),
        )
        if error:
            return None, None, None, None, error
        if not await _location_matches(db, user_id, space, project_id, folder_id, target):
            return None, None, None, None, _workspace_conflict(target)
        return space, project_id, folder_id, None, None
    space = args.get("space", "personal")
    space, project_id, folder_id, error = _coerce_loc(space, args.get("project_id"), args.get("folder_id"))
    return space, project_id, folder_id, None, error



async def _resolve_file(db, user_id, args):
    """按 file_id 或文件名 file 定位（仅未删除文件）；返回 (File|None, 错误JSON|None)。"""
    fid = args.get("file_id")
    if fid:
        f = await get_user_file(db, user_id, fid)
        if not f:
            return None, json.dumps({"error": "文件不存在"})
        return f, None
    name = args.get("file")
    if name:
        name = str(name).strip()
        base = name.rsplit(".", 1)[0] if "." in name else name
        workspace_target = await _bound_workspace_target(db, user_id)
        rows = await find_user_files_by_name(
            db, user_id, base,
            **({
                "space": workspace_target["space"],
                "project_id": workspace_target.get("project_id"),
                "folder_id": workspace_target.get("folder_id"),
                "workspace_directory_id": workspace_target.get("workspace_directory_id"),
                "root": workspace_target.get("kind") == "project",
            } if workspace_target else {}),
        )
        if not rows:
            return None, json.dumps({"error": f"未找到文件「{name}」"})
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的文件，请指明",
                                     "candidates": [{"id": f.id, "name": f"{f.display_name}.{f.ext}",
                                                     "space": f.space, "folder_id": f.folder_id} for f in rows[:10]]})
        return rows[0], None
    return None, json.dumps({"error": "需提供 file_id 或文件名 file"})
async def _folder_by_name(
    db, user_id, name, space=None, project_id=None, workspace_directory_id=None,
):
    """按名称定位文件夹，返回 (Folder|None, 错误JSON字符串|None)。

    重名时优先顶层（parent_id 为空）；仍有歧义则返回候选让调用方/模型用 folder_id 指定。
    """
    name = str(name).strip()
    rows = await find_user_folders_by_name(
        db, user_id, name, space=space, project_id=project_id,
        workspace_directory_id=workspace_directory_id,
    )
    if not rows:
        # 报错时只列出同项目/同空间的文件夹名，避免跨项目泄露
        available = await list_user_folders(
            db, user_id, project_id=project_id if space == "project" else None)
        avail = [folder.name for folder in available]
        return None, json.dumps({"error": f"未找到名为「{name}」的文件夹",
                                 "available_folders": sorted(set(avail))})
    if len(rows) > 1:
        top = [f for f in rows if f.parent_id is None]
        if len(top) == 1:
            return top[0], None
        cand = top or rows
        return None, json.dumps({"error": f"有多个名为「{name}」的文件夹，请用 folder_id 指定",
                                 "candidates": [{"id": f.id, "parent_id": f.parent_id} for f in cand]})
    return rows[0], None
