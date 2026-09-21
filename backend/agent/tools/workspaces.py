"""工作区 CRUD 工具。

工作区 ID 与项目/文件夹/目录 ID 属于不同命名空间；列表和详情显式区分目标类型。
Shell 执行仍由 shell 工具负责；本模块只管理工作区声明及顶层目录生命周期。
"""
from __future__ import annotations

from agent.security import confirm
from agent.tools.base import BaseSkill, Tool
from app.core.ownership import get_owned
from app.models import Workspace, WorkspaceDirectory
from app.services.workspaces import (
    create_workspace,
    create_workspace_directory,
    delete_workspace,
    delete_workspace_directory_with_cleanup,
    get_workspace_by_directory,
    get_workspace,
    list_workspaces_for_management,
    update_workspace,
    workspace_directory_payload,
    workspace_payload,
    workspace_shell_supported,
)


async def _list_workspaces(db, user_id, args: dict):
    """列出当前用户的全部工作区（包括停用项，便于完整 CRUD 管理）。"""
    rows = await list_workspaces_for_management(db, user_id)
    return [await workspace_payload(db, user_id, row) for row in rows]


async def _delete_workspace_directory(db, user_id, args: dict):
    """经确认删除物理工作区目录，并复用 API 的完整清理生命周期。"""
    if not workspace_shell_supported():
        return {"error": "当前存储后端不支持本地工作区目录"}
    row = await get_owned(db, WorkspaceDirectory, args["directory_id"], user_id)
    if row is None or row.deleted_at is not None:
        return {"error": "Workspace 目录不存在"}
    if row.is_default or row.is_system:
        return {"error": "默认工作区不可删除"}
    details = await workspace_directory_payload(db, user_id, row)
    summary = (
        f"删除工作区目录「{row.name}」及磁盘中的 {details['file_count']} 个文件（不可恢复）；"
        f"删除 {details['folder_count']} 个文件夹记录，解除 {details['bound_session_count']} 个会话绑定，"
        f"并停用 {details['bound_task_count']} 个定时任务"
    )
    blocked = confirm.needs_confirmation(
        args,
        summary,
        user_id,
        identity=f"delete_workspace_directory:directory_id={row.id}",
    )
    if blocked is not None:
        return blocked
    try:
        await delete_workspace_directory_with_cleanup(db, user_id, row.id)
    except (LookupError, ValueError) as exc:
        return {"error": str(exc)}
    return {"success": True, "deleted_directory_id": row.id, "name": row.name}


async def _get_workspace(db, user_id, args: dict):
    workspace_id = args.get("workspace_id")
    row = await get_workspace(db, user_id, workspace_id)
    if row is None:
        return {"error": "工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id"}
    return await workspace_payload(db, user_id, row)


async def _create_directory_workspace(
    db, user_id, *, name: str, enabled: bool,
) -> Workspace:
    """新建顶层目录并返回创建服务同步生成的唯一工作区绑定。"""
    directory = await create_workspace_directory(db, user_id, name=name)
    row = await get_workspace_by_directory(db, user_id, directory.id)
    if row is None:
        raise RuntimeError("新建工作区目录后未找到对应工作区绑定")
    if not enabled:
        row = await update_workspace(db, user_id, row.id, enabled=False)
    return row


async def _create_workspace(db, user_id, args: dict):
    name = str(args.get("name") or "").strip()
    kind = args.get("kind")
    if not name:
        return {"error": "工作区名称不能为空"}
    if kind == "project" and args.get("folder_id") is not None:
        return {"error": "kind=project 只能填写 project_id，不能填写 folder_id"}
    if kind == "folder" and args.get("project_id") is not None:
        return {"error": "kind=folder 只能填写 folder_id，不能填写 project_id"}
    try:
        if kind == "directory":
            if args.get("folder_id") is not None or args.get("project_id") is not None:
                return {"error": "kind=directory 只填写 name，不接受 folder_id 或 project_id"}
            row = await _create_directory_workspace(
                db, user_id, name=name, enabled=args.get("enabled", True),
            )
        else:
            row = await create_workspace(
                db, user_id, name=name, kind=kind,
                folder_id=args.get("folder_id"), project_id=args.get("project_id"),
                enabled=args.get("enabled", True),
            )
    except ValueError as exc:
        return {"error": str(exc)}
    return {"success": True, "workspace": await workspace_payload(db, user_id, row)}


async def _update_workspace(db, user_id, args: dict):
    if args.get("name") is None and args.get("enabled") is None:
        return {"error": "至少提供 name 或 enabled 一个要修改的字段"}
    try:
        row = await update_workspace(
            db, user_id, args["workspace_id"],
            name=args.get("name"), enabled=args.get("enabled"),
        )
    except (LookupError, ValueError) as exc:
        return {"error": str(exc)}
    return {"success": True, "workspace": await workspace_payload(db, user_id, row)}


async def _unlink_workspace(db, user_id, args: dict):
    row = await get_workspace(db, user_id, args["workspace_id"])
    if row is None:
        return {"error": "工作区不存在；workspace_id 不是 directory_id、project_id 或 folder_id"}
    blocked = confirm.needs_confirmation(
        args,
        f"解除工作区「{row.name}」的 Shell 绑定及会话绑定，不删除项目、文件夹或文件",
        user_id,
        identity=f"unlink_workspace:workspace_id={row.id}",
    )
    if blocked is not None:
        return blocked
    await delete_workspace(db, user_id, row.id)
    return {"success": True, "deleted_workspace_id": row.id, "name": row.name}


class WorkspacesSkill(BaseSkill):
    name = "workspaces"
    tools = [
        Tool(
            name="delete_workspace_directory", label="删除工作区目录",
            description_short="经用户确认删除顶层工作区目录及其磁盘内容",
            description="删除顶层物理工作区目录及其磁盘内容；会解除关联会话、停用关联任务，并关闭使用该目录的终端。先用 list_workspaces 找到 kind=directory 的项并使用其 directory_id。此操作不可恢复，执行前必须确认。不要用 delete_folder 或 unlink_workspace 代替。",
            input_schema={
                "type": "object", "properties": {
                    "directory_id": {"type": "integer"},
                }, "required": ["directory_id"], "additionalProperties": False,
            }, handler=_delete_workspace_directory, mutates=True, destructive=True,
        ),
        Tool(
            name="list_workspaces", label="查询工作区",
            description_short="统一列出工作区；kind 区分顶层目录、文件夹和项目",
            description="列出当前用户的工作区，包括停用项。kind=directory 是顶层物理工作区，kind=folder/project 是对应资源的 Shell 绑定。workspace_id 与 directory_id/folder_id/project_id 属于不同 ID。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            handler=_list_workspaces,
        ),
        Tool(
            name="get_workspace", label="查看工作区",
            description_short="查看工作区详情。",
            description="查看一个工作区及其目标；kind=directory 表示顶层物理工作区，kind=folder/project 表示对应资源绑定。workspace_id 不能当作 directory_id、project_id 或 folder_id 使用。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, repeat_safe=True, handler=_get_workspace,
        ),
        Tool(
            name="create_workspace", label="新建工作区",
            description_short="创建顶层目录，或将文件夹/项目绑定为工作区",
            description="创建工作区目标：kind=directory 用 name 创建顶层物理目录及其唯一工作区，不传 directory_id/folder_id/project_id；kind=project 用 project_id，kind=folder 用 folder_id，二者不可混用。可用 enabled 指定新绑定状态。顶层目录与文件库中的普通 folder 是不同类型。",
            input_schema={
                "type": "object", "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 200},
                    "kind": {"type": "string", "enum": ["project", "folder", "directory"]},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "enabled": {"type": "boolean"},
                }, "required": ["name", "kind"], "additionalProperties": False,
                "allOf": [
                    {"if": {"properties": {"kind": {"const": "project"}}},
                     "then": {"required": ["project_id"], "not": {"required": ["folder_id"]}}},
                    {"if": {"properties": {"kind": {"const": "folder"}}},
                     "then": {"required": ["folder_id"], "not": {"required": ["project_id"]}}},
                    {"if": {"properties": {"kind": {"const": "directory"}}},
                     "then": {"not": {"anyOf": [
                         {"required": ["folder_id"]}, {"required": ["project_id"]},
                     ]}}},
                ],
            }, handler=_create_workspace, mutates=True,
        ),
        Tool(
            name="update_workspace", label="更新工作区",
            description_short="更新工作区。",
            description="修改工作区名称或启用状态，不改变项目/文件夹绑定。kind=directory 的名称修改会同步更新顶层工作区目录显示名，但不改变物理路径。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                    "name": {"type": "string", "maxLength": 200},
                    "enabled": {"type": "boolean"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, handler=_update_workspace, mutates=True,
        ),
        Tool(
            name="unlink_workspace", label="解除工作区绑定",
            description_short="解除工作区与会话的绑定，不删除目标资源",
            description="解除 Shell 工作区与会话的绑定，不删除顶层目录、项目、文件夹或文件；执行前需确认。要物理删除 kind=directory 的顶层目录，必须使用 delete_workspace_directory。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, handler=_unlink_workspace, mutates=True, destructive=True,
        ),
    ]


WorkspacesSkill().register()
