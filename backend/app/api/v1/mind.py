"""思维面板 API（P1：记录/便签）。

只做「记录」这一半：按 `captured_at` 排的时间流 + 便签增删改 + `[[` 对象引用补全。
画布 / 语义关系类型 / 咕咕写入都是后面的阶段（见 docs/product/思维面板/实现方案.md）。

两条不变量走 `app/core/mind.py`，路由里不要自己手写：
- 更新便签用 `update_node_atomic`（原子 UPDATE + rowcount），不是「先读再比再写」；
- 正文一变就得重算 `content_plain` / 清 `indexed_at`，这层由 `update_node_atomic` 兜底。
"""
from datetime import datetime
from app.core.tz import now_utc
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.search import run_global_search
from app.core.mind import content_hash, to_plain_text, update_node_atomic
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import MindNode, User
from app.schemas import MindNoteCreate, MindNodeResponse, MindNoteUpdate, MindRefSuggestItem

router = APIRouter(prefix="/mind", tags=["mind"])

# `[[` 补全只在这三类里找：项目 / 文件 / 日历活动（客户、对话不作为便签引用对象）
_REF_TYPES = ["project", "file", "event"]


def _to_resp(n: MindNode) -> MindNodeResponse:
    return MindNodeResponse(
        id=n.id, kind=n.kind, title=n.title, content_md=n.content_md, color=n.color,
        captured_at=n.captured_at, version=n.version,
        created_at=n.created_at, updated_at=n.updated_at,
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
    captured_at = body.captured_at or now_utc()
    # 记录描述的是已经发生的想法；补录可以回填过去，但不能把记录写到未来日期。
    if captured_at.date() > datetime.now().date():
        raise HTTPException(422, "不能创建未来日期的记录")
    plain = to_plain_text(body.content_md)
    n = MindNode(
        user_id=current_user.id,
        kind="note",
        title=body.title,
        color=body.color,
        content_md=body.content_md or "",
        content_plain=plain,
        indexed_hash=content_hash(plain),
        indexed_at=None,                       # null = 待索引
        captured_at=captured_at,
    )
    db.add(n)
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
    if "content_md" in data:
        # content_plain 由服务端从正文推导，不接受客户端直接传，免得两者对不上
        data["content_plain"] = to_plain_text(data["content_md"])
    if not data:
        return _to_resp(n)

    # 原子 UPDATE：比较写在 WHERE 里，并发下不会互相覆盖；顺带清 indexed_at / 刷 indexed_hash
    ok = await update_node_atomic(db, nid, current_user.id, client_version, data)
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
    n.deleted_at = now_utc()
    await db.commit()


@router.get("/ref-suggest", response_model=list[MindRefSuggestItem])
async def ref_suggest(
    q: str = "",
    limit: int = Query(6, ge=1, le=20),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """便签里输入 `[[` 时的补全候选：复用站内搜索，只取项目/文件/活动三类。

    前端把选中项写成 `[[project:7|某项目]]`——type+id 是稳定锚点，改名/重名都不会指错。
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
    return items[: limit * len(_REF_TYPES)]
