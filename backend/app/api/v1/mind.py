"""思维面板 API（P1：记录/便签；P2：画布）。

记录是按 `captured_at` 排的时间流；画布只保存全局便签/对象节点的摆放状态，
不拥有也不删除节点本体。关系当前只有无类型的 `related`（见实现方案）。

两条不变量走 `app/core/mind.py`，路由里不要自己手写：
- 更新便签用 `update_node_atomic`（原子 UPDATE + rowcount），不是「先读再比再写」；
- 正文一变就得重算 `content_plain` / 清 `indexed_at`，这层由 `update_node_atomic` 兜底。
"""
from typing import Dict, List, Optional

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.search import run_global_search, _snippet
from app.core.mind import (
    content_hash, create_mind_note, soft_delete_mind_note, to_plain_text, update_mind_note,
    update_node_atomic, upsert_relation,
)
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.core.tz import now_utc
from app.db.session import get_db
from app.models import (
    CalendarEvent, ConversationMessage, ConversationSession, File, MindCanvasItem,
    MindMap, MindNode, MindRelation, Project, User,
)
from app.schemas import (
    MindCanvasCreate, MindCanvasItemCreate, MindCanvasItemResponse, MindCanvasItemUpdate,
    MindCanvasNoteCreate, MindCanvasNoteUpdate,
    MindCanvasResponse, MindCanvasUpdate, MindNodeResponse, MindNoteCreate, MindNoteUpdate,
    MindRefNodeCreate, MindRefSuggestItem, MindRelationCreate, MindRelationResponse,
)

router = APIRouter(prefix="/mind", tags=["mind"])

# `[[` 补全在这几类里找：项目 / 文件 / 日历活动 走公共站内搜索（run_global_search）；
# 对话（客户不作为便签引用对象）单独查——@ 一段对话锚定的是具体某条消息（"准确的聊天
# 位置"），不是整个会话，run_global_search 那边按 session 去重的逻辑在这里不适用，
# 得自己按消息为粒度查，见 ref_suggest 下半段。
_REF_TYPES = ["project", "file", "event"]


def _to_resp(n: MindNode) -> MindNodeResponse:
    return MindNodeResponse(
        id=n.id, kind=n.kind, title=n.title, content_md=n.content_md, color=n.color,
        captured_at=n.captured_at, version=n.version,
        created_at=n.created_at, updated_at=n.updated_at,
        deleted_at=n.deleted_at, ref_type=n.ref_type, ref_id=n.ref_id,
    )


async def _get_live_note(db: AsyncSession, nid: int, user_id) -> MindNode:
    """取一条未被软删的便签；不存在 / 不归属 / 已软删都按「不存在」处理。"""
    n = await get_owned(db, MindNode, nid, user_id)
    if n is None or n.deleted_at is not None or n.kind != "note":
        raise HTTPException(404, "便签不存在")
    return n


@router.get("/notes", response_model=list[MindNodeResponse])
async def list_notes(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """记录时间流：按 captured_at 倒序（不是 created_at——补录的想法要落在它「发生」的那天）。"""
    rows = (await db.execute(
        select(MindNode)
        .where(
            MindNode.user_id == current_user.id,
            MindNode.kind == "note",
            MindNode.deleted_at.is_(None),
        )
        .order_by(MindNode.captured_at.desc(), MindNode.id.desc())   # id 兜底，同一时刻也稳定有序
        .limit(limit).offset(offset)
    )).scalars().all()
    return [_to_resp(n) for n in rows]


@router.post("/notes", response_model=MindNodeResponse, status_code=201)
async def create_note(
    body: MindNoteCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        n = await create_mind_note(
            db, current_user.id, content_md=body.content_md or "", title=body.title,
            color=body.color, captured_at=body.captured_at,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    await db.commit()
    await db.refresh(n)
    return _to_resp(n)


@router.patch("/notes/{nid}", response_model=MindNodeResponse)
async def update_note(
    nid: int,
    body: MindNoteUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    n = await _get_live_note(db, nid, current_user.id)

    data = body.model_dump(exclude_unset=True, by_alias=False)
    client_version = data.pop("version")
    if not data:
        return _to_resp(n)

    # 原子 UPDATE：比较写在 WHERE 里，并发下不会互相覆盖；顺带清 indexed_at / 刷 indexed_hash
    try:
        ok = await update_mind_note(db, nid, current_user.id, client_version, data)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    if not ok:
        await db.rollback()
        raise HTTPException(409, "便签已被其他端修改，请刷新后重试")
    await db.commit()
    await db.refresh(n)
    return _to_resp(n)


@router.delete("/notes/{nid}", status_code=204)
async def delete_note(
    nid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """软删=墓碑：只写 deleted_at。节点行、它的画布项和关系全留着，图谱不静默断裂。
    真正清掉要等用户明确「清理」（那时才 DELETE 行，靠 CASCADE 连带清）。"""
    n = await _get_live_note(db, nid, current_user.id)
    if not await soft_delete_mind_note(db, nid, current_user.id, n.version):
        await db.rollback()
        raise HTTPException(409, "便签已被其他端修改，请刷新后重试")
    await db.commit()


@router.get("/ref-suggest", response_model=list[MindRefSuggestItem])
async def ref_suggest(
    q: str = "",
    limit: int = Query(6, ge=1, le=20),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """便签里输入 `@` 时的补全候选：项目/文件/活动复用站内搜索；对话单独按消息查
    （见下方），锚定的是"准确的聊天位置"而不是整个会话。

    前端把选中项写成 `[[project:7|某项目]]`——type+id 是稳定锚点，改名/重名都不会指错。
    对话引用的 id 是消息 id（不是会话 id）：点开时先按消息 id 反查所属会话
    （GET /agent/messages/{id}），再 loadSession + 定位滚动到这条消息，跟顶栏全局搜索
    命中消息时的跳转体验一致。
    """
    q = (q or "").strip()
    if not q:
        return []
    result = await run_global_search(db, current_user.id, q, per_type=limit, types=_REF_TYPES)
    items: list[MindRefSuggestItem] = []
    for g in result["groups"]:
        for it in g["items"]:
            items.append(MindRefSuggestItem(
                type=g["type"], id=it["id"], label=it["title"], subtitle=it.get("subtitle"),
            ))

    # 对话：不复用 run_global_search 按 session 去重那套——同一会话里命中的好几条消息
    # 各自都是候选，不合并成一条，好让用户精确选中"这一条"而不是"这个会话"。
    like = f"%{q}%"
    msg_rows = (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == current_user.id, ConversationMessage.content.ilike(like))
        .order_by(ConversationMessage.created_at.desc())
        .limit(limit)
    )).all()
    for m, stitle in msg_rows:
        items.append(MindRefSuggestItem(
            type="conversation", id=m.id, label=_snippet(m.content, q), subtitle=stitle,
        ))

    return items[: limit * (len(_REF_TYPES) + 1)]


# ── P2：画布（节点全局，画布只保存展示状态）──────────────────────────────────

def _load_data(raw: str) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _canvas_resp(canvas: MindMap) -> MindCanvasResponse:
    return MindCanvasResponse(
        id=canvas.id, title=canvas.title, project_id=canvas.project_id,
        data=_load_data(canvas.data_json),
        created_at=canvas.created_at, updated_at=canvas.updated_at,
    )


def _relation_resp(rel: MindRelation) -> MindRelationResponse:
    return MindRelationResponse(
        id=rel.id, src_node_id=rel.src_node_id, dst_node_id=rel.dst_node_id,
        rel_type=rel.rel_type, origin=rel.origin, status=rel.status,
        created_at=rel.created_at, updated_at=rel.updated_at,
    )


def _event_ref_data(event: CalendarEvent) -> dict:
    """画布活动卡首屏所需的只读字段，避免前端逐卡再请求一次活动详情。"""
    return {
        "date": event.date,
        "time": event.time,
        "endTime": event.end_time,
        "description": event.description,
    }


async def _ref_data_by_node_id(
    db: AsyncSession, nodes: List[MindNode], user_id,
) -> Dict[int, dict]:
    """批量补充引用节点的展示快照；当前只有活动卡有首屏额外字段。"""
    event_ids = [node.ref_id for node in nodes if node.ref_type == "event" and node.ref_id is not None]
    if not event_ids:
        return {}
    events = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == user_id,
            CalendarEvent.id.in_(event_ids),
        )
    )).scalars().all()
    data_by_event_id = {event.id: _event_ref_data(event) for event in events}
    return {
        node.id: data_by_event_id[node.ref_id]
        for node in nodes
        if node.ref_type == "event" and node.ref_id in data_by_event_id
    }


def _item_resp(
    item: MindCanvasItem, node: MindNode, ref_data: Optional[dict] = None,
) -> MindCanvasItemResponse:
    return MindCanvasItemResponse(
        id=item.id, canvas_id=item.canvas_id, node_id=item.node_id,
        x=item.x, y=item.y, w=item.w, h=item.h, z=item.z, collapsed=item.collapsed,
        data=_load_data(item.data_json), node=_to_resp(node), ref_data=ref_data,
        created_at=item.created_at, updated_at=item.updated_at,
    )


async def _get_canvas(db: AsyncSession, cid: int, user_id) -> MindMap:
    canvas = await get_owned(db, MindMap, cid, user_id)
    if canvas is None:
        raise HTTPException(404, "画布不存在")
    return canvas


@router.get("/canvases", response_model=list[MindCanvasResponse])
async def list_canvases(
    project_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(MindMap).where(MindMap.user_id == current_user.id).order_by(MindMap.updated_at.desc())
    if project_id is not None:
        stmt = stmt.where(MindMap.project_id == project_id)
    rows = (await db.execute(stmt)).scalars().all()
    return [_canvas_resp(canvas) for canvas in rows]


@router.post("/canvases", response_model=MindCanvasResponse, status_code=201)
async def create_canvas(
    body: MindCanvasCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    title = body.title.strip() or "未命名画布"
    if body.project_id is not None and await get_owned(db, Project, body.project_id, current_user.id) is None:
        raise HTTPException(404, "项目不存在")
    canvas = MindMap(user_id=current_user.id, title=title, project_id=body.project_id)
    db.add(canvas)
    await db.commit()
    await db.refresh(canvas)
    return _canvas_resp(canvas)


@router.patch("/canvases/{cid}", response_model=MindCanvasResponse)
async def update_canvas(
    cid: int,
    body: MindCanvasUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    canvas = await _get_canvas(db, cid, current_user.id)
    data = body.model_dump(exclude_unset=True, by_alias=False)
    if "title" in data:
        canvas.title = (data["title"] or "").strip() or "未命名画布"
    if "data" in data:
        canvas.data_json = json.dumps(data["data"], ensure_ascii=False)
    await db.commit()
    await db.refresh(canvas)
    return _canvas_resp(canvas)


@router.delete("/canvases/{cid}", status_code=204)
async def delete_canvas(
    cid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    canvas = await _get_canvas(db, cid, current_user.id)
    # mind_canvas_items 的 canvas_id 外键虽然声明了 ON DELETE CASCADE（生产用的 Postgres
    # 会遵守），但这里显式先删一遍——不依赖某个具体数据库后端是否真的启用了外键级联（比如
    # 测试用的内存 SQLite 默认不强制外键），行为不该随后端换了哪种数据库而变。节点
    # （MindNode）、关系（MindRelation）都是全局层，不因为画布被删而消失——同一节点/关系
    # 理论上可以出现在别的画布上，画布只是"摆哪儿"的视图状态（同 remove_canvas_item 的
    # 取舍："只删视图项，不删 MindNode 原文"）。
    await db.execute(sa_delete(MindCanvasItem).where(MindCanvasItem.canvas_id == cid))
    await db.delete(canvas)
    await db.commit()


@router.get("/canvases/{cid}/items", response_model=list[MindCanvasItemResponse])
async def list_canvas_items(
    cid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_canvas(db, cid, current_user.id)
    rows = (await db.execute(
        select(MindCanvasItem, MindNode)
        .join(MindNode, MindNode.id == MindCanvasItem.node_id)
        .where(MindCanvasItem.canvas_id == cid, MindCanvasItem.user_id == current_user.id)
        .order_by(MindCanvasItem.z, MindCanvasItem.id)
    )).all()
    ref_data_by_node_id = await _ref_data_by_node_id(db, [node for _, node in rows], current_user.id)
    return [_item_resp(item, node, ref_data_by_node_id.get(node.id)) for item, node in rows]


@router.post("/canvases/{cid}/items", response_model=MindCanvasItemResponse, status_code=201)
async def add_canvas_item(
    cid: int,
    body: MindCanvasItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_canvas(db, cid, current_user.id)
    node = await get_owned(db, MindNode, body.node_id, current_user.id)
    if node is None or node.deleted_at is not None:
        raise HTTPException(404, "节点不存在")

    existing = await db.scalar(select(MindCanvasItem).where(
        MindCanvasItem.canvas_id == cid, MindCanvasItem.node_id == node.id,
    ))
    if existing is not None:
        ref_data = (await _ref_data_by_node_id(db, [node], current_user.id)).get(node.id)
        return _item_resp(existing, node, ref_data)

    item = MindCanvasItem(
        user_id=current_user.id, canvas_id=cid, node_id=node.id,
        x=body.x, y=body.y, w=body.w, h=body.h, z=body.z, collapsed=body.collapsed,
        data_json=json.dumps(body.data, ensure_ascii=False),
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    ref_data = (await _ref_data_by_node_id(db, [node], current_user.id)).get(node.id)
    return _item_resp(item, node, ref_data)


@router.post("/canvases/{cid}/notes", response_model=MindCanvasItemResponse, status_code=201)
async def create_canvas_note(
    cid: int,
    body: MindCanvasNoteCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """新建画布专属便签：它是独立节点，不会混进记录时间流。"""
    await _get_canvas(db, cid, current_user.id)
    plain = to_plain_text(body.content_md)
    node = MindNode(
        user_id=current_user.id, kind="canvas_note", title=body.title.strip() or "新便签",
        content_md=body.content_md, content_plain=plain, color=body.color,
        indexed_hash=content_hash(plain), indexed_at=None,
    )
    db.add(node)
    await db.flush()  # MindCanvasItem 没有 node relationship，先拿到独立节点主键
    item = MindCanvasItem(
        user_id=current_user.id, canvas_id=cid, node_id=node.id,
        x=body.x, y=body.y, w=body.w, h=body.h, z=body.z,
    )
    db.add(item)
    await db.commit()
    await db.refresh(node)
    await db.refresh(item)
    return _item_resp(item, node)


@router.patch("/nodes/{nid}", response_model=MindNodeResponse)
async def update_canvas_note(
    nid: int,
    body: MindCanvasNoteUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await get_owned(db, MindNode, nid, current_user.id)
    if node is None or node.kind != "canvas_note" or node.deleted_at is not None:
        raise HTTPException(404, "画布便签不存在")
    data = body.model_dump(exclude_unset=True, by_alias=False)
    client_version = data.pop("version")
    if "content_md" in data:
        data["content_plain"] = to_plain_text(data["content_md"])
    if not data:
        return _to_resp(node)
    if not await update_node_atomic(db, nid, current_user.id, client_version, data):
        await db.rollback()
        raise HTTPException(409, "画布便签已被其他端修改，请刷新后重试")
    await db.commit()
    await db.refresh(node)
    return _to_resp(node)


@router.patch("/canvases/{cid}/items/{iid}", response_model=MindCanvasItemResponse)
async def update_canvas_item(
    cid: int,
    iid: int,
    body: MindCanvasItemUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_canvas(db, cid, current_user.id)
    item = await get_owned(db, MindCanvasItem, iid, current_user.id)
    if item is None or item.canvas_id != cid:
        raise HTTPException(404, "画布贴纸不存在")
    node = await get_owned(db, MindNode, item.node_id, current_user.id)
    if node is None:
        raise HTTPException(404, "节点不存在")

    data = body.model_dump(exclude_unset=True, by_alias=False)
    if "data" in data:
        item.data_json = json.dumps(data.pop("data"), ensure_ascii=False)
    for key, value in data.items():
        setattr(item, key, value)
    await db.commit()
    await db.refresh(item)
    ref_data = (await _ref_data_by_node_id(db, [node], current_user.id)).get(node.id)
    return _item_resp(item, node, ref_data)


@router.delete("/canvases/{cid}/items/{iid}", status_code=204)
async def remove_canvas_item(
    cid: int,
    iid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_canvas(db, cid, current_user.id)
    item = await get_owned(db, MindCanvasItem, iid, current_user.id)
    if item is None or item.canvas_id != cid:
        raise HTTPException(404, "画布贴纸不存在")
    await db.delete(item)  # 只删视图项，不删 MindNode 原文
    await db.commit()


@router.get("/canvases/{cid}/relations", response_model=list[MindRelationResponse])
async def list_canvas_relations(
    cid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _get_canvas(db, cid, current_user.id)
    node_ids = select(MindCanvasItem.node_id).where(
        MindCanvasItem.canvas_id == cid, MindCanvasItem.user_id == current_user.id,
    )
    rows = (await db.execute(
        select(MindRelation).where(
            MindRelation.user_id == current_user.id,
            MindRelation.src_node_id.in_(node_ids),
            MindRelation.dst_node_id.in_(node_ids),
        ).order_by(MindRelation.id)
    )).scalars().all()
    return [_relation_resp(rel) for rel in rows]


@router.post("/relations", response_model=MindRelationResponse, status_code=201)
async def create_relation(
    body: MindRelationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for nid in (body.src_node_id, body.dst_node_id):
        if await get_owned(db, MindNode, nid, current_user.id) is None:
            raise HTTPException(404, "节点不存在")
    try:
        relation = await upsert_relation(
            db, current_user.id, body.src_node_id, body.dst_node_id,
            allow_parallel=body.allow_parallel,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    await db.commit()
    await db.refresh(relation)
    return _relation_resp(relation)


@router.delete("/relations/{rid}", status_code=204)
async def delete_relation(
    rid: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    relation = await get_owned(db, MindRelation, rid, current_user.id)
    if relation is None:
        raise HTTPException(404, "关联不存在")
    await db.delete(relation)
    await db.commit()


@router.post("/nodes/ref", response_model=MindNodeResponse, status_code=201)
async def create_ref_node(
    body: MindRefNodeCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """把既有对象接入全局图层；同一用户/对象永远复用同一 ref 节点。"""
    targets = {
        "project": (Project, "name"),
        "file": (File, "display_name"),
        "event": (CalendarEvent, "title"),
    }
    target = targets.get(body.ref_type)
    if target is None:
        raise HTTPException(422, "不支持的引用类型")
    model, label_attr = target
    entity = await get_owned(db, model, body.ref_id, current_user.id)
    if entity is None:
        raise HTTPException(404, "引用对象不存在")

    node = await db.scalar(select(MindNode).where(
        MindNode.user_id == current_user.id,
        MindNode.kind == "ref",
        MindNode.ref_type == body.ref_type,
        MindNode.ref_id == body.ref_id,
    ))
    if node is None:
        node = MindNode(
            user_id=current_user.id, kind="ref", ref_type=body.ref_type, ref_id=body.ref_id,
            title=getattr(entity, label_attr), content_md="", content_plain="",
        )
        db.add(node)
        await db.commit()
        await db.refresh(node)
    return _to_resp(node)
