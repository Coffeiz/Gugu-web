"""站内全局搜索：一个 q 跨 项目/文件/文件夹/日程/客户/对话 检索（按 user_id 隔离）。

简单子串匹配（ILIKE %q%），对中文也有效、无需建全文索引。各类型各取前 N 条，
分组返回，供顶栏全局搜索框下拉展示 + 点击跳转。对话同时搜会话标题与消息正文。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models import (
    User, Project, File, Folder, CalendarEvent, Client,
    ConversationSession, ConversationMessage,
)

router = APIRouter(prefix="/search", tags=["search"])

PER_TYPE = 6          # 每个类型返回的最大条数
MSG_PER_TYPE = 8      # 对话消息扫描条数（合并去重后仍受 PER_TYPE 限制）
SNIPPET_PAD = 24      # 消息片段命中词前后各取多少字


def _snippet(text: str, q: str) -> str:
    """从命中处截一小段，首尾加省略号，方便下拉里展示上下文。"""
    if not text:
        return ""
    low = text.lower()
    i = low.find(q.lower())
    if i < 0:
        return text[:60].strip()
    start = max(0, i - SNIPPET_PAD)
    end = min(len(text), i + len(q) + SNIPPET_PAD)
    seg = text[start:end].strip().replace("\n", " ")
    return ("…" if start > 0 else "") + seg + ("…" if end < len(text) else "")


@router.get("")
async def search(
    q: str = "",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = (q or "").strip()
    if not q:
        return {"query": q, "total": 0, "groups": []}
    uid = current_user.id
    like = f"%{q}%"
    groups: list = []

    # ── 项目：名/客户/当前阶段 ──
    rows = (await db.execute(
        select(Project).where(
            Project.user_id == uid,
            or_(Project.name.ilike(like), Project.client.ilike(like),
                Project.current_stage.ilike(like)),
        ).order_by(Project.updated_at.desc()).limit(PER_TYPE)
    )).scalars().all()
    if rows:
        groups.append({"type": "project", "label": "项目", "items": [
            {"id": p.id, "title": p.name,
             "subtitle": " · ".join(filter(None, [p.client, p.status]))}
            for p in rows
        ]})

    # ── 文件：文件名（排除回收站）──
    rows = (await db.execute(
        select(File).where(
            File.user_id == uid, File.deleted_at.is_(None),
            or_(File.display_name.ilike(like), File.ext.ilike(like)),
        ).order_by(File.updated_at.desc()).limit(PER_TYPE)
    )).scalars().all()
    if rows:
        _space = {"project": "项目", "mind": "思维", "asset": "素材", "personal": "个人"}
        groups.append({"type": "file", "label": "文件", "items": [
            {"id": f.id, "title": f"{f.display_name}.{f.ext}" if f.ext else f.display_name,
             "subtitle": f"{_space.get(f.space, f.space)}空间 · {f.size}".strip(" ·")}
            for f in rows
        ]})

    # ── 文件夹：名 ──
    rows = (await db.execute(
        select(Folder).where(Folder.user_id == uid, Folder.name.ilike(like))
        .order_by(Folder.created_at.desc()).limit(PER_TYPE)
    )).scalars().all()
    if rows:
        groups.append({"type": "folder", "label": "文件夹", "items": [
            {"id": fo.id, "title": fo.name, "subtitle": "文件夹"} for fo in rows
        ]})

    # ── 日程/事件：标题/描述/客户 ──
    rows = (await db.execute(
        select(CalendarEvent).where(
            CalendarEvent.user_id == uid,
            or_(CalendarEvent.title.ilike(like), CalendarEvent.description.ilike(like),
                CalendarEvent.client.ilike(like)),
        ).order_by(CalendarEvent.date.desc()).limit(PER_TYPE)
    )).scalars().all()
    if rows:
        groups.append({"type": "event", "label": "日程", "items": [
            {"id": e.id, "title": e.title, "date": e.date,
             "subtitle": " · ".join(filter(None, [e.date, e.client]))}
            for e in rows
        ]})

    # ── 客户：名/联系人/邮箱/电话/备注 ──
    rows = (await db.execute(
        select(Client).where(
            Client.user_id == uid,
            or_(Client.name.ilike(like), Client.contact.ilike(like),
                Client.email.ilike(like), Client.phone.ilike(like),
                Client.notes.ilike(like)),
        ).order_by(Client.created_at.desc()).limit(PER_TYPE)
    )).scalars().all()
    if rows:
        groups.append({"type": "client", "label": "客户", "items": [
            {"id": c.id, "title": c.name,
             "subtitle": " · ".join(filter(None, [c.contact, c.email, c.phone]))}
            for c in rows
        ]})

    # ── 对话：会话标题 + 消息正文（合并去重，正文命中给片段）──
    conv: dict = {}   # session_id → {id, title, subtitle}
    title_rows = (await db.execute(
        select(ConversationSession).where(
            ConversationSession.user_id == uid, ConversationSession.title.ilike(like),
        ).order_by(ConversationSession.updated_at.desc()).limit(PER_TYPE)
    )).scalars().all()
    for s in title_rows:
        conv[s.id] = {"id": s.id, "title": s.title, "subtitle": "对话"}

    msg_rows = (await db.execute(
        select(ConversationMessage, ConversationSession.title)
        .join(ConversationSession, ConversationMessage.session_id == ConversationSession.id)
        .where(ConversationSession.user_id == uid, ConversationMessage.content.ilike(like))
        .order_by(ConversationMessage.created_at.desc()).limit(MSG_PER_TYPE)
    )).all()
    for m, stitle in msg_rows:
        if m.session_id not in conv:
            conv[m.session_id] = {"id": m.session_id, "title": stitle,
                                  "subtitle": _snippet(m.content, q)}
        if len(conv) >= PER_TYPE:
            break
    if conv:
        groups.append({"type": "conversation", "label": "对话",
                       "items": list(conv.values())[:PER_TYPE]})

    total = sum(len(g["items"]) for g in groups)
    return {"query": q, "total": total, "groups": groups}
