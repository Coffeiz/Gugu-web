"""客户领域技能：list_clients / create_client。

逻辑对应后端 `/clients` API（`Client` 模型 CRUD），带 user_id 隔离。
"""
import json

from sqlalchemy import select

from app.models import Client
from app.core.ownership import get_owned
from agent import confirm
from agent.tools.base import BaseSkill, Tool


async def _list_clients(db, user_id, args: dict):
    rows = (await db.execute(
        select(Client).where(Client.user_id == user_id).order_by(Client.created_at.desc())
    )).scalars().all()
    return [
        {"id": c.id, "name": c.name, "contact": c.contact,
         "email": c.email, "phone": c.phone, "notes": c.notes}
        for c in rows
    ]


async def _create_client(db, user_id, args: dict):
    if not args.get("name"):
        return json.dumps({"error": "客户名称必填"})
    c = Client(
        user_id=user_id, name=args["name"], contact=args.get("contact"),
        email=args.get("email"), phone=args.get("phone"),
        notes=args.get("notes", ""),
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return {"success": True, "client_id": c.id, "name": c.name}


async def _resolve_client(db, user_id, args):
    """按 client_id 或客户名 client 定位；返回 (Client|None, 错误JSON|None)。"""
    cid = args.get("client_id")
    if cid:
        c = await get_owned(db, Client, cid, user_id)
        if not c:
            return None, json.dumps({"error": "客户不存在"})
        return c, None
    name = args.get("client")
    if name:
        name = str(name).strip()
        rows = (await db.execute(
            select(Client).where(Client.user_id == user_id, Client.name == name)
        )).scalars().all()
        if not rows:
            rows = (await db.execute(
                select(Client).where(Client.user_id == user_id, Client.name.ilike(f"%{name}%"))
            )).scalars().all()
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
    for field in fields:
        if field in args:
            setattr(c, field, args[field])
    await db.commit()
    return {"success": True, "client_id": c.id, "name": c.name}


async def _delete_client(db, user_id, args: dict):
    c, _err = await _resolve_client(db, user_id, args)
    if _err:
        return _err
    summary = f"将删除客户「{c.name}」，此操作不可恢复"
    blocked = confirm.needs_confirmation(args, summary, user_id)
    if blocked is not None:
        return blocked
    cid, cname = c.id, c.name
    await db.delete(c)
    await db.commit()
    return {"success": True, "deleted_client_id": cid, "name": cname}


class ClientsSkill(BaseSkill):
    name = "clients"
    tools = [
        Tool(
            name="list_clients", label="查询客户",
            description="列出当前用户的所有客户。",
            input_schema={"type": "object", "properties": {}},
            handler=_list_clients,
        ),
        Tool(
            name="create_client", label="新建客户",
            description="新建客户，记录联系人、邮箱、电话、备注。",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "客户名称"},
                    "contact": {"type": "string", "description": "联系人"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["name"],
            },
            handler=_create_client,
        ),
        Tool(
            name="update_client", label="更新客户",
            description="修改客户信息（名称/联系人/邮箱/电话/备注）。",
            input_schema={
                "type": "object",
                "properties": {
                    "client_id": {"type": "integer", "description": "客户 id（可选）"},
                    "client": {"type": "string", "description": "客户名称（推荐：直接用名字）"},
                    "name": {"type": "string"},
                    "contact": {"type": "string"},
                    "email": {"type": "string"},
                    "phone": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": [],
            },
            handler=_update_client,
        ),
        Tool(
            name="delete_client", label="删除客户",
            description="删除客户（不可恢复）。流程：先不带 confirm 调用 → 返回影响详情 → 转达用户征得明确同意 → 带 confirm=true 再调一次执行。",
            input_schema={
                "type": "object",
                "properties": {
                    "client_id": {"type": "integer", "description": "客户 id（可选）"},
                    "client": {"type": "string", "description": "客户名称（推荐：直接用名字）"},
                    "confirm": {"type": "boolean", "description": "确认执行；仅在用户明确同意后置 true"},
                    "confirm_token": {"type": "string", "description": "上一步确认请求返回的短时确认凭证"},
                },
                "required": [],
            },
            handler=_delete_client,
            destructive=True,
        ),
    ]


ClientsSkill().register()
