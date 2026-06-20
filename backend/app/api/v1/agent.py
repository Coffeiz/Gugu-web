"""AI Agent 接口 — SSE 流式对话，注入项目上下文"""
import json
from datetime import datetime
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import get_current_user
from app.db.session import get_db, _SessionLocal, _build_engine, _engine
from app.models import (
    CalendarEvent, ConversationMessage, ConversationSession, Project, User,
)

router = APIRouter(prefix="/agent", tags=["agent"])


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None


def _build_system_prompt(user: User, projects: list, events: list) -> str:
    today = datetime.now().strftime("%Y-%m-%d")

    proj_lines = []
    for p in projects[:25]:
        deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
        stages = p.stages
        done_cnt = sum(1 for s in stages if s.get("done"))
        total_cnt = len(stages)
        prog = f"{done_cnt}/{total_cnt}阶段完成" if total_cnt else "无阶段"
        client_str = f"客户：{p.client}" if p.client else "无客户"
        proj_lines.append(
            f"- [{p.status}] {p.name}（{prog}，{deadline}，{client_str}）"
        )

    ev_lines = []
    for ev in events[:10]:
        ev_lines.append(f"- {ev.date} {ev.title}")

    proj_block = "\n".join(proj_lines) if proj_lines else "暂无进行中的项目"
    ev_block = "\n".join(ev_lines) if ev_lines else "暂无近期事件"

    return f"""你是「咕咕 PM Agent」，一个为自由职业创作者设计的 AI 项目管理助手。
用户：{user.username}
今天：{today}

## 用户的项目（共 {len(projects)} 个）
{proj_block}

## 近期日历事件
{ev_block}

请用简洁的中文回答，聚焦关键信息，适合对话气泡（避免超长列表）。
如果用户问项目进度、截止日期、排期，请结合上方数据回答。
如果问题与项目管理无关，也可以正常帮助用户。"""


async def _stream(
    user_id: int, user_name: str, body: ChatRequest
) -> AsyncGenerator[str, None]:
    """独立管理 DB session，避免 Depends(get_db) 在 StreamingResponse 返回后提前关闭。"""
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    settings = get_settings()

    async with _sess._SessionLocal() as db:
        # ── 查询项目和近期事件 ────────────────────────────────────────────
        proj_result = await db.execute(
            select(Project)
            .where(Project.user_id == user_id, Project.archived == False)
            .order_by(Project.updated_at.desc())
        )
        projects = proj_result.scalars().all()

        today = datetime.now().strftime("%Y-%m-%d")
        ev_result = await db.execute(
            select(CalendarEvent)
            .where(CalendarEvent.user_id == user_id, CalendarEvent.date >= today)
            .order_by(CalendarEvent.date)
            .limit(10)
        )
        events = ev_result.scalars().all()

        # ── 获取或新建会话 ────────────────────────────────────────────────
        session = None
        if body.session_id:
            res = await db.execute(
                select(ConversationSession).where(
                    ConversationSession.id == body.session_id,
                    ConversationSession.user_id == user_id,
                )
            )
            session = res.scalars().first()

        if not session:
            session = ConversationSession(
                user_id=user_id,
                title=body.message[:50],
            )
            db.add(session)
            await db.flush()

        # ── 查历史消息（最近 10 条）──────────────────────────────────────
        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session.id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(10)
        )
        history = list(reversed(hist_res.scalars().all()))

        # ── 保存用户消息 ──────────────────────────────────────────────────
        user_msg = ConversationMessage(
            session_id=session.id,
            role="user",
            content=body.message,
        )
        db.add(user_msg)
        await db.commit()

        session_id = session.id

    # ── 构建 prompt（DB 已关闭，在外部继续生成）────────────────────────────
    # user 对象来自上面的查询，但 session 已关闭，只保留已加载的字段
    class _UserProxy:
        username = user_name

    system_prompt = _build_system_prompt(_UserProxy(), projects, events)
    messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        messages.append({"role": h.role, "content": h.content})
    messages.append({"role": "user", "content": body.message})

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    # ── 调用 AI（流式）────────────────────────────────────────────────────
    from openai import AsyncOpenAI

    ai_client = AsyncOpenAI(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
    )

    full_reply = ""
    try:
        stream = await ai_client.chat.completions.create(
            model=settings.ai.model,
            messages=messages,
            stream=True,
            max_tokens=800,
            temperature=0.7,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                full_reply += delta
                yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"

        # ── 保存 AI 回复 ───────────────────────────────────────────────────
        async with _sess._SessionLocal() as db2:
            ai_msg = ConversationMessage(
                session_id=session_id,
                role="assistant",
                content=full_reply,
            )
            db2.add(ai_msg)
            await db2.commit()

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except Exception as e:
        detail = str(e)[:200]
        yield f"data: {json.dumps({'type': 'error', 'detail': f'AI 服务暂时不可用：{detail}'})}\n\n"


@router.post("/chat")
async def chat(
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    return StreamingResponse(
        _stream(current_user.id, current_user.username, body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
