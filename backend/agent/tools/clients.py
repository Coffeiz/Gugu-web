"""客户领域技能：list_clients / create_client。

逻辑对应后端 `/clients` API（`Client` 模型 CRUD），带 user_id 隔离。
"""
import json

from app.services.clients import (
    create_client,
    delete_client,
    find_clients_by_name,
    get_client,
    list_clients,
    update_client,
)
from agent.security import confirm
from agent.tools.base import BaseSkill, Tool


async def _list_clients(db, user_id, args: dict):
    rows = await list_clients(db, user_id)
    return [
        {"id": c.id, "name": c.name, "contact": c.contact,
         "email": c.email, "phone": c.phone, "notes": c.notes}
        for c in rows
    ]


async def _create_client(db, user_id, args: dict):
    if not args.get("name"):
        return json.dumps({"error": "客户名称必填"})
    c = await create_client(
        db, user_id, name=args["name"], contact=args.get("contact"),
        email=args.get("email"), phone=args.get("phone"),
        notes=args.get("notes", ""),
    )
    return {"success": True, "client_id": c.id, "name": c.name}


async def _resolve_client(db, user_id, args):
    """按 client_id 或客户名 client 定位；返回 (Client|None, 错误JSON|None)。"""
    cid = args.get("client_id")
    if cid:
        c = await get_client(db, user_id, cid)
        if not c:
            return None, json.dumps({"error": "客户不存在"})
        return c, None
    name = args.get("client")
    if name:
        name = str(name).strip()
        rows = await find_clients_by_name(db, user_id, name)
        if not rows:
            return None, json.dumps({"error": f"未找到客户「{name}」"})
        if len(rows) > 1:
            return None, json.dumps({"error": f"有多个匹配「{name}」的客户，请指明",
                                     "candidates": [{"id": c.id, "name": c.name} for c in rows[:10]]})
        return rows[0], None
    return None, json.dumps({"error": "需提供 client_id 或客户名 client"})


async def _update_client(db, user_id, args: dict):
    c, _err = await _resolve_client(db, user_id, args)
    if _err:
        return _err
    fields = ("name", "contact", "email", "phone", "notes")
    if not any(fld in args for fld in fields):   # 没给任何要改的字段 → 别假成功（防咕咕误报"已更新"）
        return json.dumps({"error": "没提供要修改的字段（name/contact/email/phone/notes），未改动。"})
    await update_client(db, c, {field: args[field] for field in fields if field in args})
    return {"success": True, "client_id": c.id, "name": c.name}


async def _delete_client(db, user_id, args: dict):
    client_ids = args.get("client_ids")
    if client_ids is not None:
        if not isinstance(client_ids, list) or not client_ids or len(client_ids) > 50:
            return json.dumps({"error": "client_ids 必须是 1-50 个客户 id"})
        clients = []
        for cid in client_ids:
            client = await get_client(db, user_id, cid)
            if client is None:
                return json.dumps({"error": f"客户 {cid} 不存在"})
            clients.append(client)
        names = "、".join(c.name for c in clients[:10])
        if len(clients) > 10:
            names += f"等 {len(clients)} 个"
        blocked = confirm.needs_confirmation(
            args, f"将删除客户：{names}，共 {len(clients)} 个，此操作不可恢复", user_id,
            identity=f"delete_client:client_ids={sorted(client_ids)}")
        if blocked is not None:
            return blocked
        results = []
        for client in clients:
            cid, name = await delete_client(db, client)
            results.append({"deleted_client_id": cid, "name": name})
        await db.commit()
        return {"success": True, "deleted_count": len(results), "results": results}
    c, _err = await _resolve_client(db, user_id, args)
    if _err:
        return _err
    summary = f"将删除客户「{c.name}」，此操作不可恢复"
    blocked = confirm.needs_confirmation(args, summary, user_id,
                                         identity=f"delete_client:client_id={c.id}")
    if blocked is not None:
        return blocked
    cid, cname = await delete_client(db, c)
    return {"success": True, "deleted_client_id": cid, "name": cname}


class ClientsSkill(BaseSkill):
    name = "clients"
    tools = [
        Tool(
            name="list_clients", label="查询客户",
            description_short='查询当前用户的客户列表；无需参数',
            description="列出当前用户的所有客户。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_clients,
        ),
        Tool(
            name="create_client", label="新建客户",
            description_short='新建客户。',
            description="新建客户，记录联系人、邮箱、电话、备注。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "contact": {"type": "string"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["name"],
            },
            handler=_create_client,
            mutates=True,
        ),
        Tool(
            name="update_client", label="更新客户",
            description_short='更新客户。',
            description="修改客户信息（名称/联系人/邮箱/电话/备注）。",
            input_schema={
                "type": "object",
                "properties": {
                    "client_id": {"type": "integer"},
                    "client": {"type": "string"},
                    "client_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                    "name": {"type": "string"},
                    "contact": {"type": "string"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": [],
            },
            handler=_update_client,
            mutates=True,
        ),
        Tool(
            name="delete_client", label="删除客户",
            description_short='删除客户，执行前确认。',
            description="删除一个或多个客户（不可恢复）。单项传 client_id/client，批量传 client_ids。批量目标一次确认，禁止逐项重复确认。",
            input_schema={
                "type": "object",
                "properties": {
                    "client_id": {"type": "integer"},
                    "client": {"type": "string"},
                    "client_ids": {"type": "array", "items": {"type": "integer"}, "maxItems": 50},
                },
                "required": [],
            },
            handler=_delete_client,
            mutates=True,
            destructive=True,
        ),
    ]


ClientsSkill().register()
