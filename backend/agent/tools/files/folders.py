"""文件夹查询、创建、重命名、删除与移动。"""

from __future__ import annotations

import json

from app.core.redaction import redact
from app.services.files.browser import (
    descendant_folder_ids,
    find_user_folders_by_name,
    get_user_folder,
    list_user_folders,
)
from app.services.storage.file_service import FileService
from app.services.storage.folders import resolve_folder_path
from .locations import (
    _bound_workspace_target, _coerce_loc, _folder_by_name,
    _norm_target, _resolve_file, _target_loc,
)

async def _move_one(db, user_id, f, target: dict) -> dict:
    """把已解析的 File f 移到 target，各自 commit。返回结果 dict（成功或 {"error":...}）。
    供 move_items 移动文件时复用（单个文件也走它）。"""
    target = _norm_target(target)
    space, project_id, folder_id, workspace_directory_id = _target_loc(f, target)
    space, project_id, folder_id, loc_err = _coerce_loc(space, project_id, folder_id)
    if loc_err:
        return loc_err

    # 支持按文件夹「名称」移动（agent 通常不知道 folder_id）
    fname = target.get("folder")
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            folder_id = None
        else:
            fo, err = await _folder_by_name(
                db, user_id, fname, space, project_id, workspace_directory_id,
            )
            if err:
                return err
            folder_id = fo.id
            # 文件夹决定归属项目：以 folder 的 project_id 为准，避免跨项目移动后 project_id 与 folder 不一致
            if fo.project_id is not None:
                project_id = fo.project_id
                space = "project"
            workspace_directory_id = fo.workspace_directory_id

    # 无变动 → 明确报错，而不是假成功（避免咕咕误报"已移动"）
    cur_pid = f.project_id
    new_pid = project_id if space == "project" else None
    if (
        folder_id == f.folder_id
        and space == f.space
        and new_pid == cur_pid
        and workspace_directory_id == f.workspace_directory_id
    ):
        return json.dumps({"error": "未指定有效目标或文件已在该位置，未移动。"
                                    "请用 target.folder 指定目标文件夹名，或先用 list_folders 确认。",
                           "current_folder_id": f.folder_id})

    try:
        result = await FileService(db).update_file(
            user_id,
            f.id,
            display_name=None,
            stage_name=target.get("stage_name") if "stage_name" in target else None,
            folder_id=folder_id,
            project_id=new_pid,
            workspace_directory_id=workspace_directory_id,
            workspace_directory_set=True,
            folder_set=True,
            project_set=True,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    moved = result.file
    folder_name = result.folder_name or "（根目录）"
    # 明确回报落点的「空间/项目/文件夹」，别只给文件夹名——否则模型无从确认到底进了哪个项目，
    # 容易自行脑补位置（曾出现移到项目根目录后谎报项目/文件名的情况）
    project_name = result.project.name if result.project else None
    return {"success": True, "file_id": moved.id, "name": f"{moved.display_name}.{moved.ext}",
            "space": moved.space, "project_id": moved.project_id, "project_name": project_name,
            "folder_id": moved.folder_id, "moved_to": folder_name}


def _as_dict(r):
    """把 _move_one 的返回归一成 dict（错误分支历史上返回 json 字符串）。"""
    if isinstance(r, str):
        try:
            return json.loads(r)
        except Exception:
            return {"error": r}
    return r


# ── move_items：统一「集合移动」（文件 + 文件夹混合，文件夹后端递归展开）──────────────

async def _descendant_folder_ids(db, user_id, root_id: int) -> list[int]:
    """root_id 及其所有子孙文件夹 id（沿 parent_id 逐层 BFS）。"""
    return await descendant_folder_ids(db, user_id, root_id)


async def _resolve_target(db, user_id, target: dict):
    """把 target 解析成统一落点。返回
    ``(space, project_id, folder_id, workspace_directory_id, err_dict|None)``。
    支持 folder_id（最准）/ folder 名 + space/project_id 限定 / 不给文件夹=空间根。
    space="workspace" ＝ 当前绑定工作区的文件目录；与 create_file 一致，
    不暴露跨工作区写入，目录 id 一律取绑定落点。"""
    space = target.get("space")
    project_id = target.get("project_id")
    folder_id = target.get("folder_id")
    fname = target.get("folder")
    bound_wd = None
    if space == "workspace" or target.get("workspace_directory_id"):
        bound = await _bound_workspace_target(db, user_id)
        bound_wd = (bound or {}).get("workspace_directory_id")
        if bound_wd is None:
            return None, None, None, None, {
                "error": "当前会话没有绑定带文件目录的工作区，无法以 space=workspace 为目标",
                "hint": "省略目标位置参数即写入当前绑定落点，或改用 personal/project。",
            }
    if folder_id:
        fo = await get_user_folder(db, user_id, folder_id)
        if not fo:
            return None, None, None, None, {"error": "目标文件夹不存在"}
        return (
            ("project" if fo.project_id else ("workspace" if fo.workspace_directory_id else "personal")),
            fo.project_id,
            fo.id,
            fo.workspace_directory_id,
            None,
        )
    if fname is not None:
        fname = str(fname).strip()
        if fname in ("", "根", "根目录", "/"):
            sp = space or ("project" if project_id else "personal")
            return sp, (project_id if sp == "project" else None), None, (bound_wd if sp == "workspace" else target.get("workspace_directory_id")), None
        sp = space or ("project" if project_id else "personal")
        fo, err = await _folder_by_name(
            db, user_id, fname, sp, project_id, bound_wd if sp == "workspace" else target.get("workspace_directory_id"),
        )
        if err:
            return None, None, None, None, {"error": f"目标文件夹「{fname}」没找到，请用 list_folders 确认，或改用 folder_id"}
        return (
            ("project" if fo.project_id else ("workspace" if fo.workspace_directory_id else "personal")),
            fo.project_id,
            fo.id,
            fo.workspace_directory_id,
            None,
        )
    sp = space or "personal"
    return sp, (project_id if sp == "project" else None), None, (bound_wd if sp == "workspace" else target.get("workspace_directory_id")), None


async def _move_folder(db, user_id, folder, t_space, t_pid, t_parent_id, t_workspace_id=None) -> dict:
    """委托 FileService 搬文件夹树，并同步重建所有后代文件的物理路径。"""
    name = folder.name
    sub_ids = await _descendant_folder_ids(db, user_id, folder.id)
    try:
        await FileService(db).move_folder(
            user_id, folder.id, t_parent_id, client_version=folder.version,
            target_project_id=t_pid,
            target_project_set=True,
            target_workspace_directory_id=t_workspace_id,
            target_workspace_set=True,
        )
        await db.commit()
    except Exception as e:
        return {"error": redact(f"{type(e).__name__}: {e}")}
    return {"success": True, "type": "folder", "folder": name,
            "subfolders": len(sub_ids) - 1,
            "space": t_space, "project_id": t_pid}


async def _move_items(db, user_id, args: dict):
    """统一移动：files + folders 一次搬到同一 target。文件夹连内容递归搬（后端展开，
    Agent 不必知道里面有多少文件）。逐条如实回报成功/失败。"""
    target = _norm_target(args.get("target", {}))
    workspace_target = await _bound_workspace_target(db, user_id)
    if workspace_target is not None and not any(
        target.get(key) not in (None, "") for key in ("space", "project_id", "folder_id", "folder")
    ):
        target = {key: workspace_target.get(key) for key in ("space", "project_id", "folder_id", "workspace_directory_id")}
    t_space, t_pid, t_folder_id, t_workspace_id, terr = await _resolve_target(db, user_id, target)
    if terr:
        return terr
    file_target = {
        "space": t_space,
        "project_id": t_pid,
        "folder_id": t_folder_id,
        "workspace_directory_id": t_workspace_id,
    }

    moved_files, moved_folders, failed = [], [], []
    # 文件
    for it in (args.get("files") or []):
        sub = {}
        if isinstance(it, int) or (isinstance(it, str) and str(it).strip().isdigit()):
            sub["file_id"] = int(it)
        else:
            sub["file"] = str(it)
        f, _err = await _resolve_file(db, user_id, sub)
        if _err:
            failed.append({"item": it, "kind": "file", "error": "没找到这个文件"})
            continue
        r = _as_dict(await _move_one(db, user_id, f, file_target))
        (moved_files if r.get("success") else failed).append(
            r if r.get("success") else {"item": it, "kind": "file", **r})
    # 文件夹
    for it in (args.get("folders") or []):
        if isinstance(it, int) or (isinstance(it, str) and str(it).strip().isdigit()):
            fo = await get_user_folder(db, user_id, int(it))
        else:
            # 按名找：在源处可能任意空间，这里全局按名匹配（重名则提示用 id）
            rows = await find_user_folders_by_name(db, user_id, str(it))
            fo = rows[0] if len(rows) == 1 else None
            if len(rows) > 1:
                failed.append({"item": it, "kind": "folder", "error": "有多个同名文件夹，请改用 folder_id"})
                continue
        if not fo:
            failed.append({"item": it, "kind": "folder", "error": "没找到这个文件夹"})
            continue
        r = await _move_folder(db, user_id, fo, t_space, t_pid, t_folder_id, t_workspace_id)
        (moved_folders if r.get("success") else failed).append(
            r if r.get("success") else {"item": it, "kind": "folder", **r})

    return {"success": True,
            "moved_files": len(moved_files), "moved_folders": len(moved_folders),
            "failed_count": len(failed),
            "files": moved_files, "folders": moved_folders, "failed": failed}


async def _create_folder(db, user_id, args: dict):
    """绑定工作区只提供省略目标时的默认落点；显式 project_id/parent_id 按参数
    使用（围栏只约束 Shell，文件工具不受会话绑定限制）。"""
    workspace_target = await _bound_workspace_target(db, user_id)
    project_id = args.get("project_id")
    parent_id = args.get("parent_id")
    workspace_directory_id = None
    explicit_location = any(
        value not in (None, "") for value in (project_id, parent_id, args.get("space"))
    )
    if workspace_target is not None and not explicit_location:
        project_id = workspace_target.get("project_id")
        parent_id = workspace_target.get("folder_id")
        workspace_directory_id = workspace_target.get("workspace_directory_id")
    else:
        if parent_id not in (None, ""):
            try:
                parent_id = int(parent_id)
            except (TypeError, ValueError):
                return {"error": "parent_id 必须是文件夹 id"}
            parent = await get_user_folder(db, user_id, parent_id)
            if not parent:
                return {"error": "目标父文件夹不存在"}
            # 空间跟随父文件夹：项目文件夹→项目空间，工作区文件夹→工作区空间
            if project_id in (None, ""):
                project_id = parent.project_id
                workspace_directory_id = parent.workspace_directory_id
        elif project_id in (None, "") and workspace_target is not None:
            # 只给了 name：绑定会话仍默认落绑定工作区
            project_id = workspace_target.get("project_id")
            parent_id = workspace_target.get("folder_id")
            workspace_directory_id = workspace_target.get("workspace_directory_id")
    try:
        fo = await FileService(db).create_folder(
            user_id, name=args["name"], parent_id=parent_id,
            project_id=project_id, workspace_directory_id=workspace_directory_id,
        )
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    await db.commit()
    return {"success": True, "folder_id": fo.id, "name": fo.name}



async def _list_folders(db, user_id, args: dict):
    rows = await list_user_folders(
        db, user_id,
        space=args.get("space"),
        project_id=args.get("project_id"),
        parent_id=args.get("parent_id"),
        workspace_directory_id=args.get("workspace_directory_id"),
    )
    out = []
    for folder in rows:
        resolved = await resolve_folder_path(
            db, user_id, folder.id, folder.project_id,
            folder.workspace_directory_id,
        )
        if not resolved:
            continue
        _, path = resolved
        out.append({
            "id": folder.id, "name": folder.name, "path": path,
            "project_id": folder.project_id, "parent_id": folder.parent_id,
            "depth": path.count("/"),
        })
    return sorted(out, key=lambda item: (item["depth"], item["path"]))


async def _find_folder(db, user_id, args: dict):
    """按 folder_id 或文件夹名定位；返回 Folder 或错误 JSON 字符串（含可选项）。"""
    fid = args.get("folder_id")
    if fid:
        try:
            fid = int(str(fid).strip())
        except (ValueError, TypeError):
            pass
        fo = await get_user_folder(db, user_id, fid)
        if not fo:
            return json.dumps({"error": "文件夹不存在"})
        return fo
    name = args.get("name") or args.get("folder")
    if name:
        # 把调用方传来的项目上下文透传进去，防止跨项目同名文件夹被误操作
        pid = args.get("project_id")
        try:
            pid = int(str(pid).strip()) if pid not in (None, "") else None
        except (ValueError, TypeError):
            pid = None
        space = "project" if pid else args.get("space")
        workspace_target = await _bound_workspace_target(db, user_id)
        workspace_directory_id = None
        if workspace_target is not None and space is None and pid is None:
            space = workspace_target.get("space")
            pid = workspace_target.get("project_id")
            workspace_directory_id = workspace_target.get("workspace_directory_id")
        fo, err = await _folder_by_name(
            db, user_id, name, space, pid, workspace_directory_id,
        )
        return err if err else fo
    return json.dumps({"error": "需提供 folder_id 或文件夹名 name"})


async def _rename_folder(db, user_id, args: dict):
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    try:
        fo = await FileService(db).rename_folder(
            user_id, fo.id, args["new_name"], client_version=fo.version,
        )
        await db.commit()
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    return {"success": True, "folder_id": fo.id, "name": fo.name}


async def _delete_folder(db, user_id, args: dict):
    folder_ids = args.get("folder_ids")
    if folder_ids is not None:
        if not isinstance(folder_ids, list) or not folder_ids or len(folder_ids) > 50:
            return json.dumps({"error": "folder_ids 必须是 1-50 个文件夹 id"})
        folders = []
        for folder_id in folder_ids:
            folder = await _find_folder(db, user_id, {"folder_id": folder_id})
            if isinstance(folder, str):
                return folder
            folders.append(folder)
        results = []
        try:
            for folder in folders:
                await FileService(db).delete_folder(user_id, folder.id)
                results.append({"deleted_folder_id": folder.id, "name": folder.name,
                                "_file_op": {"op": "remove", "kind": "folder", "id": folder.id}})
            await db.commit()
        except Exception as e:
            return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
        return {"success": True, "deleted_count": len(results), "results": results}
    fo = await _find_folder(db, user_id, args)
    if isinstance(fo, str):
        return fo
    fid = fo.id
    fname = fo.name
    try:
        await FileService(db).delete_folder(user_id, fo.id)
        await db.commit()
    except Exception as e:
        return json.dumps({"error": redact(f"{type(e).__name__}: {e}")})
    note = f"文件夹「{fname}」已删除，其中的文件已移入回收站（30 天内可恢复）"
    return {"success": True, "deleted_folder_id": fid, "note": note,
            "_file_op": {"op": "remove", "kind": "folder", "id": fid}}
