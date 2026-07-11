"""站内全局搜索：一个 q 跨 项目/文件/文件夹/日程/客户/对话 检索（按 user_id 隔离）。

简单子串匹配（ILIKE %q%），对中文也有效、无需建全文索引。各类型各取前 N 条，
分组返回，供顶栏全局搜索框下拉展示 + 点击跳转。对话同时搜会话标题与消息正文。

`run_global_search` 是查询核心，路由和 agent 工具（`agent/tools/global_search.py`）
共用——路由给下拉框用小 per_type，工具给模型用更大的 per_type，避免各写一套。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models import (
    User, Project, File, Folder, CalendarEvent, Client,
    ConversationSession, ConversationMessage, MindNode,
)
from app.utils.romaji import is_romaji_query, romaji_match

router = APIRouter(prefix="/search", tags=["search"])

PER_TYPE = 6          # 每个类型返回的最大条数（下拉框用）
MSG_PER_TYPE = 8      # 对话消息扫描条数（合并去重后仍受 per_type 限制）
SNIPPET_PAD = 24      # 消息片段命中词前后各取多少字
ROMAJI_SCAN = 200     # 拼音/罗马音搜索时每类最多扫描条数

ALL_TYPES = ["project", "file", "folder", "event", "client", "conversation", "note"]


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


def _primary_rank(column, q: str):
    """名称精确/前缀命中优先于纯子串命中；只用标准 SQL，SQLite 测试也保持一致。"""
    normalized = q.lower()
    return case(
        (func.lower(column) == normalized, 0),
        (func.lower(column).like(f"{normalized}%"), 1),
        else_=2,
    )


async def run_global_search(db: AsyncSession, user_id, q: str, *,
                            per_type: int = PER_TYPE, types: list[str] | None = None) -> dict:
    """跨类型子串搜索核心逻辑。`types` 不传则搜全部，传了只搜指定类型
    （值域见 ALL_TYPES：project/file/folder/event/client/conversation）。"""
    q = (q or "").strip()
    if not q:
        return {"query": q, "total": 0, "groups": []}
    wanted = set(types) if types else None
    uid = user_id
    like = f"%{q}%"
    groups: list = []
    use_romaji = is_romaji_query(q)

    # ── 项目：名/客户/当前阶段 ──
    if wanted is None or "project" in wanted:
        rows = list((await db.execute(
            select(Project).where(
                Project.user_id == uid,
                or_(Project.name.ilike(like), Project.client.ilike(like),
                    Project.current_stage.ilike(like)),
            ).order_by(_primary_rank(Project.name, q), Project.updated_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {p.id for p in rows}
            scan = (await db.execute(
                select(Project).where(Project.user_id == uid)
                .order_by(Project.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for p in scan:
                if p.id not in seen and (
                    romaji_match(p.name, q) or romaji_match(p.client or "", q)
                ):
                    rows.append(p); seen.add(p.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "project", "label": "项目", "items": [
                {"id": p.id, "title": p.name,
                 "subtitle": " · ".join(filter(None, [p.client, p.status]))}
                for p in rows
            ]})

    # ── 文件：文件名（排除回收站）──
    if wanted is None or "file" in wanted:
        rows = list((await db.execute(
            select(File).where(
                File.user_id == uid, File.deleted_at.is_(None),
                or_(File.display_name.ilike(like), File.ext.ilike(like)),
            ).order_by(_primary_rank(File.display_name, q), File.updated_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {f.id for f in rows}
            scan = (await db.execute(
                select(File).where(File.user_id == uid, File.deleted_at.is_(None))
                .order_by(File.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for f in scan:
                if f.id not in seen and romaji_match(f.display_name or "", q):
                    rows.append(f); seen.add(f.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            _space = {"project": "项目", "mind": "思维", "asset": "素材", "personal": "个人"}
            groups.append({"type": "file", "label": "文件", "items": [
                {"id": f.id, "title": f"{f.display_name}.{f.ext}" if f.ext else f.display_name,
                 "subtitle": f"{_space.get(f.space, f.space)}空间 · {f.size}".strip(" ·")}
                for f in rows
            ]})

    # ── 文件夹：名 ──
    if wanted is None or "folder" in wanted:
        rows = list((await db.execute(
            select(Folder).where(Folder.user_id == uid, Folder.name.ilike(like))
            .order_by(_primary_rank(Folder.name, q), Folder.created_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {fo.id for fo in rows}
            scan = (await db.execute(
                select(Folder).where(Folder.user_id == uid)
                .order_by(Folder.created_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for fo in scan:
                if fo.id not in seen and romaji_match(fo.name or "", q):
                    rows.append(fo); seen.add(fo.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "folder", "label": "文件夹", "items": [
                {"id": fo.id, "title": fo.name, "subtitle": "文件夹"} for fo in rows
            ]})

    # ── 日程/事件：标题/描述/客户 ──
    if wanted is None or "event" in wanted:
        rows = list((await db.execute(
            select(CalendarEvent).where(
                CalendarEvent.user_id == uid,
                or_(CalendarEvent.title.ilike(like), CalendarEvent.description.ilike(like),
                    CalendarEvent.client.ilike(like)),
            ).order_by(_primary_rank(CalendarEvent.title, q), CalendarEvent.date.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {e.id for e in rows}
            scan = (await db.execute(
                select(CalendarEvent).where(CalendarEvent.user_id == uid)
                .order_by(CalendarEvent.date.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for e in scan:
                if e.id not in seen and (
                    romaji_match(e.title or "", q) or romaji_match(e.description or "", q)
                ):
                    rows.append(e); seen.add(e.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "event", "label": "日程", "items": [
                {"id": e.id, "title": e.title, "date": e.date,
                 "subtitle": " · ".join(filter(None, [e.date, e.client]))}
                for e in rows
            ]})

    # ── 客户：名/联系人/邮箱/电话/备注 ──
    if wanted is None or "client" in wanted:
        rows = list((await db.execute(
            select(Client).where(
                Client.user_id == uid,
                or_(Client.name.ilike(like), Client.contact.ilike(like),
                    Client.email.ilike(like), Client.phone.ilike(like),
                    Client.notes.ilike(like)),
            ).order_by(_primary_rank(Client.name, q), Client.created_at.desc()).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {c.id for c in rows}
            scan = (await db.execute(
                select(Client).where(Client.user_id == uid)
                .order_by(Client.created_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for c in scan:
                if c.id not in seen and (
                    romaji_match(c.name or "", q) or romaji_match(c.contact or "", q)
                ):
                    rows.append(c); seen.add(c.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "client", "label": "客户", "items": [
                {"id": c.id, "title": c.name,
                 "subtitle": " · ".join(filter(None, [c.contact, c.email, c.phone]))}
                for c in rows
            ]})

    # ── 思维便签：标题 + 正文（便签短，正文可以直接搜，不像文件那样只能搜名）──
    #    只搜 kind='note'：ref 节点只是业务对象的引用代理，真身已经在上面各类里搜过了，
    #    再出一遍就是重复；软删的墓碑也不该出现在搜索里。
    if wanted is None or "note" in wanted:
        rows = list((await db.execute(
            select(MindNode).where(
                MindNode.user_id == uid,
                MindNode.kind == "note",
                MindNode.deleted_at.is_(None),
                or_(MindNode.title.ilike(like), MindNode.content_plain.ilike(like)),
            ).order_by(
                case(
                    (func.lower(MindNode.title) == q.lower(), 0),
                    (func.lower(MindNode.title).like(f"{q.lower()}%"), 1),
                    (MindNode.title.ilike(like), 2),
                    else_=3,  # 只在正文命中：保留，但排在标题命中之后
                ),
                MindNode.captured_at.desc(),
            ).limit(per_type)
        )).scalars().all())
        if use_romaji and len(rows) < per_type:
            seen = {n.id for n in rows}
            scan = (await db.execute(
                select(MindNode).where(
                    MindNode.user_id == uid, MindNode.kind == "note",
                    MindNode.deleted_at.is_(None),
                ).order_by(MindNode.captured_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for n in scan:
                # 罗马音只匹标题：正文可能很长，逐字转拼音代价不划算
                if n.id not in seen and romaji_match(n.title or "", q):
                    rows.append(n); seen.add(n.id)
                    if len(rows) >= per_type:
                        break
        if rows:
            groups.append({"type": "note", "label": "便签", "items": [
                {"id": n.id,
                 "title": n.title or _snippet(n.content_plain, q) or "无标题便签",
                 "subtitle": _snippet(n.content_plain, q)}
                for n in rows
            ]})

    # ── 对话：会话标题 + 消息正文（合并去重，正文命中给片段）──
    if wanted is None or "conversation" in wanted:
        conv: dict = {}   # session_id → {id, title, subtitle}
        title_rows = (await db.execute(
            select(ConversationSession).where(
                ConversationSession.user_id == uid, ConversationSession.title.ilike(like),
            ).order_by(_primary_rank(ConversationSession.title, q), ConversationSession.updated_at.desc()).limit(per_type)
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
                                      "subtitle": _snippet(m.content, q),
                                      "message_id": m.id}
            if len(conv) >= per_type:
                break

        if use_romaji and len(conv) < per_type:
            # 拼音/罗马音扫描对话标题
            sess_scan = (await db.execute(
                select(ConversationSession).where(ConversationSession.user_id == uid)
                .order_by(ConversationSession.updated_at.desc()).limit(ROMAJI_SCAN)
            )).scalars().all()
            for s in sess_scan:
                if s.id not in conv and romaji_match(s.title or "", q):
                    conv[s.id] = {"id": s.id, "title": s.title, "subtitle": "对话"}
                    if len(conv) >= per_type:
                        break

        if conv:
            groups.append({"type": "conversation", "label": "对话",
                           "items": list(conv.values())[:per_type]})

    total = sum(len(g["items"]) for g in groups)
    return {"query": q, "total": total, "groups": groups}


@router.get("")
async def search(
    q: str = "",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await run_global_search(db, current_user.id, q)
