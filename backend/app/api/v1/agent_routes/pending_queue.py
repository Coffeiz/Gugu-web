"""Agent API pending queue endpoints."""

from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from agent.llm import genstream
from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ConversationSession, User
from app.services import conversation_pending_queue

router = APIRouter()


class PendingQueueAttachment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    file_id: Optional[int] = None
    attach_id: Optional[str] = Field(default=None, max_length=128)
    name: Optional[str] = Field(default=None, max_length=512)
    ext: Optional[str] = Field(default=None, max_length=32)
    size: Optional[int] = Field(default=None, ge=0)
    size_bytes: Optional[int] = Field(default=None, ge=0)
    kind: Optional[str] = Field(default=None, max_length=32)
    mime: Optional[str] = Field(default=None, max_length=128)
    qq_face: Optional[bool] = None
    quoted: Optional[bool] = None
    duration: Optional[float] = Field(default=None, ge=0)
    upload: Optional[bool] = None
    img_width: Optional[int] = Field(default=None, ge=0)
    img_height: Optional[int] = Field(default=None, ge=0)

class PendingQueueReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # mcp 的 id 是 UUID 字符串（user_mcp_servers 主键），其余类型是 int 自增（>0）
    type: Literal["project", "file", "event", "conversation", "canvas_note", "skill", "mcp", "scheduled_task"]
    id: int | UUID
    label: str = Field(max_length=512)

    @field_validator("id")
    @classmethod
    def _validate_reference_id(cls, value):
        if isinstance(value, int) and value < 1:
            raise ValueError("id must be >= 1")
        return value

class PendingQueueItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: int = Field(gt=0)
    text: str = Field(max_length=200_000)
    attachments: list[PendingQueueAttachment] = Field(default_factory=list, max_length=32)
    references: list[PendingQueueReference] = Field(default_factory=list, max_length=50)

class PendingQueueUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[PendingQueueItem] = Field(max_length=200)

class PendingQueuePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int = Field(gt=0)
    items: list[PendingQueueItem] = Field(default_factory=list, max_length=200)
    remove_keys: list[int] = Field(default_factory=list, max_length=200)

class PendingQueueClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int = Field(gt=0)

class PendingQueueReleaseRequest(PendingQueueClaimRequest):
    claim_token: str = Field(min_length=1, max_length=128)

@router.get("/pending-queues/imported-drafts")
async def list_imported_draft_queues(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出当前用户通过数据导入恢复的新对话草稿。"""
    queues = await conversation_pending_queue.list_imported_draft_queues(
        db, user_id=current_user.id,
    )
    return {"queues": queues}

@router.get("/pending-queues/{queue_id}")
async def get_pending_queue_by_id(
    queue_id: str = Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """读取草稿或会话队列快照。"""
    session_id, items = await conversation_pending_queue.get_pending_queue_by_id(
        db,
        user_id=current_user.id,
        queue_id=queue_id,
    )
    return {"sessionId": session_id, "items": items}

@router.put("/pending-queues/{queue_id}")
async def update_draft_pending_queue(
    queue_id: str,
    body: PendingQueueUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """全量替换尚未绑定会话的新对话草稿队列。"""
    if len(queue_id) > 64 or not queue_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "队列标识无效")
    if queue_id.startswith("session-"):
        raise HTTPException(409, "会话队列必须使用增量更新")
    items = [item.model_dump(mode="json", exclude_none=True) for item in body.items]
    await conversation_pending_queue.replace_draft_pending_queue(
        db,
        user_id=current_user.id,
        queue_id=queue_id,
        items=items,
    )
    return {"ok": True, "count": len(body.items)}

@router.patch("/pending-queues/{queue_id}")
async def patch_session_pending_queue(
    request: Request,
    queue_id: str = Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    body: PendingQueuePatch = ...,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not queue_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "队列标识无效")
    session = await get_owned(db, ConversationSession, body.session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "对话不存在")
    expected_id = conversation_pending_queue.session_pending_queue_id(session.id)
    if queue_id != expected_id:
        raise HTTPException(409, "队列标识与会话不一致")
    await conversation_pending_queue.patch_pending_queue(
        db,
        user_id=current_user.id,
        queue_id=expected_id,
        session_id=body.session_id,
        upsert_items=[item.model_dump(mode="json", exclude_none=True) for item in body.items],
        remove_keys=body.remove_keys,
    )
    if body.items or body.remove_keys:
        await conversation_pending_queue.publish_session_pending_queue_changed(
            current_user.id,
            body.session_id,
            origin=request.headers.get("X-Client-Id"),
        )
    return {"ok": True, "count": len(body.items)}

@router.post("/pending-queues/{queue_id}/items/{item_key}/claim")
async def claim_session_pending_queue_item(
    queue_id: str = Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    item_key: int = Path(gt=0),
    body: PendingQueueClaimRequest = ...,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not queue_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "队列标识无效")
    session = await get_owned(db, ConversationSession, body.session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "对话不存在")
    expected_id = conversation_pending_queue.session_pending_queue_id(session.id)
    if queue_id != expected_id:
        raise HTTPException(409, "队列标识与会话不一致")
    if await genstream.is_active(session.id):
        return {"claim_token": None, "reason": "session_active"}
    token = await conversation_pending_queue.claim_pending_queue_item(
        db,
        user_id=current_user.id,
        queue_id=expected_id,
        session_id=session.id,
        item_key=item_key,
    )
    return {"claim_token": token}

@router.post("/pending-queues/{queue_id}/items/{item_key}/release")
async def release_session_pending_queue_item(
    request: Request,
    queue_id: str = Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    item_key: int = Path(gt=0),
    body: PendingQueueReleaseRequest = ...,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not queue_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(422, "队列标识无效")
    session = await get_owned(db, ConversationSession, body.session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "对话不存在")
    expected_id = conversation_pending_queue.session_pending_queue_id(session.id)
    if queue_id != expected_id:
        raise HTTPException(409, "队列标识与会话不一致")
    released = await conversation_pending_queue.release_pending_queue_claim(
        db,
        user_id=current_user.id,
        queue_id=expected_id,
        session_id=session.id,
        item_key=item_key,
        claim_token=body.claim_token,
    )
    if released:
        await conversation_pending_queue.publish_session_pending_queue_changed(
            current_user.id,
            body.session_id,
            origin=request.headers.get("X-Client-Id"),
        )
    return {"released": released}
