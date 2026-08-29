"""工作区 CRUD 工具。

工作区 ID 与项目/文件夹 ID 属于不同命名空间；工具结果始终显式返回字段名，
避免模型把 ``workspace_id=4`` 误当成 ``project_id=4``。Shell 执行仍由 shell
工具负责，本模块只管理工作区声明及其生命周期。
"""
from __future__ import annotations

from sqlalchemy import func, select

from agent.security import confirm
from agent.tools.base import BaseSkill, Tool
from app.models import ConversationSession, Folder, Project, Workspace
from app.services.workspaces import (
    create_workspace,
    delete_workspace,
    get_workspace,
    update_workspace,
)


async def _workspace_payload(db, user_id, row: Workspace) -> dict:
    """构造稳定的、带命名空间字段的工具结果。"""
    count = await db.scalar(
        select(func.count(ConversationSession.id)).where(
            ConversationSession.user_id == user_id,
            ConversationSession.workspace_id == row.id,
        )
    )
    result = {
        "workspace_id": row.id,
        "name": row.name,
        "kind": row.kind,
        "enabled": row.enabled,
        "is_default": row.is_default,
        "bound_session_count": int(count or 0),
        "project_id": row.project_id,
        "folder_id": row.folder_id,
    }
    if row.project_id is not None:
        project = await db.scalar(select(Project).where(Project.id == row.project_id, Project.user_id == user_id))
        result["project_name"] = project.name if project else None
    if row.folder_id is not None:
        folder = await db.scalar(select(Folder).where(Folder.id == row.folder_id, Folder.user_id == user_id))
        result["folder_name"] = folder.name if folder else None
    return result


async def _list_workspaces(db, user_id, args: dict):
    """列出当前用户的全部工作区（包括停用项，便于完整 CRUD 管理）。"""
    result = await db.execute(
        select(Workspace).where(Workspace.user_id == user_id).order_by(
            Workspace.updated_at.desc(), Workspace.id.desc()
        )
    )
    return [await _workspace_payload(db, user_id, row) for row in result.scalars().all()]


async def _get_workspace(db, user_id, args: dict):
    workspace_id = args.get("workspace_id")
    row = await get_workspace(db, user_id, workspace_id)
    if row is None:
        return {"error": "工作区不存在；workspace_id 不是 project_id 或 folder_id"}
    return await _workspace_payload(db, user_id, row)


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
        row = await create_workspace(
            db, user_id, name=name, kind=kind,
            folder_id=args.get("folder_id"), project_id=args.get("project_id"),
            enabled=args.get("enabled", True),
        )
    except ValueError as exc:
        return {"error": str(exc)}
    return {"success": True, "workspace": await _workspace_payload(db, user_id, row)}


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
    return {"success": True, "workspace": await _workspace_payload(db, user_id, row)}


async def _delete_workspace(db, user_id, args: dict):
    row = await get_workspace(db, user_id, args["workspace_id"])
    if row is None:
        return {"error": "工作区不存在；workspace_id 不是 project_id 或 folder_id"}
    blocked = confirm.needs_confirmation(
        args,
        f"将删除工作区「{row.name}」，只解除工作区及会话绑定，不删除项目、文件夹或文件",
        user_id,
        identity=f"delete_workspace:workspace_id={row.id}",
    )
    if blocked is not None:
        return blocked
    await delete_workspace(db, user_id, row.id)
    return {"success": True, "deleted_workspace_id": row.id, "name": row.name}


class WorkspacesSkill(BaseSkill):
    name = "workspaces"
    tools = [
        Tool(
            name="list_workspaces", label="查询工作区",
            description_short="查询工作区列表；返回 workspace_id 与绑定对象",
            description="列出当前用户的工作区，包括停用项；workspace_id 与 project_id/folder_id 是不同 ID。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            handler=_list_workspaces,
        ),
        Tool(
            name="get_workspace", label="查看工作区",
            description_short="查看工作区详情；关键字段 workspace_id",
            description="查看一个工作区及其项目/文件夹绑定；workspace_id 不能当作 project_id 使用。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, handler=_get_workspace,
        ),
        Tool(
            name="create_workspace", label="新建工作区",
            description_short="新建工作区；kind=project/folder，填写对应 ID",
            description="创建 Shell 工作区声明；kind=project 用 project_id，kind=folder 用 folder_id，二者不可混用。",
            input_schema={
                "type": "object", "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 200},
                    "kind": {"type": "string", "enum": ["project", "folder"]},
                    "project_id": {"type": "integer"},
                    "folder_id": {"type": "integer"},
                    "enabled": {"type": "boolean"},
                }, "required": ["name", "kind"], "additionalProperties": False,
                "allOf": [
                    {"if": {"properties": {"kind": {"const": "project"}}},
                     "then": {"required": ["project_id"], "not": {"required": ["folder_id"]}}},
                    {"if": {"properties": {"kind": {"const": "folder"}}},
                     "then": {"required": ["folder_id"], "not": {"required": ["project_id"]}}},
                ],
            }, handler=_create_workspace, mutates=True,
        ),
        Tool(
            name="update_workspace", label="更新工作区",
            description_short="更新工作区；关键字段 workspace_id/name/enabled",
            description="修改工作区名称或启用状态，不改变项目/文件夹绑定。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                    "name": {"type": "string", "maxLength": 200},
                    "enabled": {"type": "boolean"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, handler=_update_workspace, mutates=True,
        ),
        Tool(
            name="delete_workspace", label="删除工作区",
            description_short="删除工作区；关键字段 workspace_id，执行前确认",
            description="删除工作区声明并解除会话绑定，不删除项目、文件夹或文件；执行前需确认。",
            input_schema={
                "type": "object", "properties": {
                    "workspace_id": {"type": "integer"},
                    "confirm": {"type": "boolean"},
                    "confirm_token": {"type": "string"},
                }, "required": ["workspace_id"], "additionalProperties": False,
            }, handler=_delete_workspace, mutates=True, destructive=True,
        ),
    ]


WorkspacesSkill().register()
