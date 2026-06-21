"""AI Agent — 工具调用 + SSE 流式，支持 Anthropic / OpenAI 双路"""
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
from app.db.session import get_db
from app.models import CalendarEvent, ConversationMessage, ConversationSession, Project, User

router = APIRouter(prefix="/agent", tags=["agent"])


# ── 工具定义 ──────────────────────────────────────────────────────────────────

TOOL_LABELS = {
    "list_projects":  "查询项目列表",
    "update_project": "更新项目",
    "create_project": "新建项目",
    "create_event":   "新建日历事件",
}

_TOOLS_ANTHROPIC = [
    {
        "name": "list_projects",
        "description": "获取用户的项目列表，可按状态筛选。返回 id、名称、状态、截止日期、客户、阶段进度。",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["pending", "active", "done"],
                    "description": "按状态筛选（不传则返回全部）",
                }
            },
        },
    },
    {
        "name": "update_project",
        "description": "修改项目的状态、截止日期、开始日期、备注、客户名称。",
        "input_schema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "integer", "description": "项目 ID"},
                "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                "deadline":   {"type": "string", "description": "截止日期 YYYY-MM-DD"},
                "start_date": {"type": "string", "description": "开始日期 YYYY-MM-DD"},
                "client":     {"type": "string", "description": "客户名称"},
                "notes":      {"type": "string", "description": "备注"},
                "name":       {"type": "string", "description": "项目名称"},
            },
            "required": ["project_id"],
        },
    },
    {
        "name": "create_project",
        "description": "创建新项目。",
        "input_schema": {
            "type": "object",
            "properties": {
                "name":       {"type": "string", "description": "项目名称"},
                "client":     {"type": "string"},
                "status":     {"type": "string", "enum": ["pending", "active", "done"]},
                "deadline":   {"type": "string", "description": "YYYY-MM-DD"},
                "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                "notes":      {"type": "string"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "create_event",
        "description": "在日历上创建事件或截止提醒。",
        "input_schema": {
            "type": "object",
            "properties": {
                "title":      {"type": "string"},
                "date":       {"type": "string", "description": "YYYY-MM-DD"},
                "type":       {"type": "string", "enum": ["event", "deadline"], "description": "默认 event"},
                "project_id": {"type": "integer", "description": "关联项目 ID（可选）"},
            },
            "required": ["title", "date"],
        },
    },
]

# OpenAI 格式（function calling）
_TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": t["name"],
            "description": t["description"],
            "parameters": t["input_schema"],
        },
    }
    for t in _TOOLS_ANTHROPIC
]


# ── 工具执行 ──────────────────────────────────────────────────────────────────

async def _exec_tool(user_id: int, name: str, args: dict) -> str:
    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        if name == "list_projects":
            stmt = select(Project).where(
                Project.user_id == user_id,
                Project.archived == False,
            ).order_by(Project.updated_at.desc())
            result = await db.execute(stmt)
            projects = result.scalars().all()
            if args.get("status"):
                projects = [p for p in projects if p.status == args["status"]]
            data = [
                {
                    "id": p.id,
                    "name": p.name,
                    "status": p.status,
                    "deadline": p.deadline,
                    "start_date": p.start_date,
                    "client": p.client,
                    "notes": p.notes,
                    "stages_done": sum(1 for s in p.stages if s.get("done")),
                    "stages_total": len(p.stages),
                }
                for p in projects
            ]
            return json.dumps(data, ensure_ascii=False)

        if name == "update_project":
            result = await db.execute(
                select(Project).where(
                    Project.id == args["project_id"],
                    Project.user_id == user_id,
                )
            )
            p = result.scalars().first()
            if not p:
                return json.dumps({"error": "项目不存在"})
            if "status" in args:
                if args["status"] == "done" and p.done_at is None:
                    p.done_at = datetime.utcnow()
                p.status = args["status"]
            for field in ("deadline", "start_date", "client", "notes", "name"):
                if field in args:
                    setattr(p, field, args[field])
            p.updated_at = datetime.utcnow()
            await db.commit()
            return json.dumps({"success": True, "project_id": p.id, "name": p.name})

        if name == "create_project":
            p = Project(
                user_id=user_id,
                name=args["name"],
                client=args.get("client"),
                status=args.get("status", "pending"),
                deadline=args.get("deadline"),
                start_date=args.get("start_date"),
                notes=args.get("notes", ""),
            )
            db.add(p)
            await db.commit()
            await db.refresh(p)
            return json.dumps({"success": True, "project_id": p.id, "name": p.name})

        if name == "create_event":
            pid = args.get("project_id")
            if pid is not None:
                proj = await db.get(Project, pid)
                if not proj or proj.user_id != user_id:
                    return json.dumps({"error": "项目不存在"})
            ev = CalendarEvent(
                user_id=user_id,
                title=args["title"],
                date=args["date"],
                type=args.get("type", "event"),
                project_id=pid,
            )
            db.add(ev)
            await db.commit()
            return json.dumps({"success": True, "title": args["title"], "date": args["date"]})

    return json.dumps({"error": f"未知工具: {name}"})


# ── 请求 / 响应模型 ──────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[int] = None


# ── 系统 Prompt ───────────────────────────────────────────────────────────────

def _build_system_prompt(user_name: str, projects: list, events: list) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    proj_lines = []
    for p in projects[:25]:
        deadline = f"截止 {p.deadline}" if p.deadline else "无截止"
        done_cnt  = sum(1 for s in p.stages if s.get("done"))
        total_cnt = len(p.stages)
        prog = f"{done_cnt}/{total_cnt}阶段" if total_cnt else "无阶段"
        proj_lines.append(f"- [id={p.id}] [{p.status}] {p.name}（{prog}，{deadline}，客户：{p.client or '无'}）")

    ev_lines = [f"- {ev.date} {ev.title}" for ev in events[:10]]
    proj_block = "\n".join(proj_lines) if proj_lines else "暂无项目"
    ev_block   = "\n".join(ev_lines)   if ev_lines   else "暂无近期事件"

    return f"""你是「咕咕 PM Agent」，自由职业创作者的 AI 项目管理助手。
用户：{user_name}  今天：{today}

## 当前项目（共 {len(projects)} 个）
{proj_block}

## 近期日历事件
{ev_block}

你可以通过工具查询、创建、更新项目和日历事件。
回答简洁，操作完成后说明做了什么。"""


# ── Anthropic 智能体循环（MiniMax / Anthropic）───────────────────────────────

async def _loop_anthropic(
    user_id: int, system_text: str, messages: list, settings
) -> AsyncGenerator[str, None]:
    import httpx
    from anthropic import AsyncAnthropic

    _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
    client = AsyncAnthropic(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        http_client=httpx.AsyncClient(timeout=_timeout),
    )

    MAX_ROUNDS = 5
    for _ in range(MAX_ROUNDS):
        # 非流式调用，检测是否有工具调用
        resp = await client.messages.create(
            model=settings.ai.model,
            system=system_text,
            messages=messages,
            tools=_TOOLS_ANTHROPIC,
            max_tokens=2000,
        )

        has_tool = any(b.type == "tool_use" for b in resp.content)

        if has_tool:
            tool_results = []
            for block in resp.content:
                if block.type == "tool_use":
                    label = TOOL_LABELS.get(block.name, block.name)
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block.name, 'label': label, 'input': block.input}, ensure_ascii=False)}\n\n"
                    result = await _exec_tool(user_id, block.name, block.input)
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': block.name, 'label': label}, ensure_ascii=False)}\n\n"
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })

            messages.append({"role": "assistant", "content": resp.content})
            messages.append({"role": "user", "content": tool_results})
            continue  # 继续循环

        # 无工具调用 → 流式输出最终文本
        async with client.messages.stream(
            model=settings.ai.model,
            system=system_text,
            messages=messages,
            max_tokens=2000,
        ) as stream:
            async for delta in stream.text_stream:
                yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
        return

    # 超过最大轮次
    yield f"data: {json.dumps({'type': 'error', 'detail': '工具调用轮次超限'})}\n\n"


# ── OpenAI 智能体循环 ─────────────────────────────────────────────────────────

async def _loop_openai(
    user_id: int, messages: list, settings
) -> AsyncGenerator[str, None]:
    import httpx
    from openai import AsyncOpenAI

    _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
    client = AsyncOpenAI(
        api_key=settings.ai.api_key or "dummy",
        base_url=settings.ai.base_url,
        timeout=_timeout,
    )

    MAX_ROUNDS = 5
    for _ in range(MAX_ROUNDS):
        # 非流式调用，检测工具调用
        resp = await client.chat.completions.create(
            model=settings.ai.model,
            messages=messages,
            tools=_TOOLS_OPENAI,
            tool_choice="auto",
            max_tokens=2000,
        )
        msg = resp.choices[0].message

        if msg.tool_calls:
            messages.append(msg)
            for tc in msg.tool_calls:
                label = TOOL_LABELS.get(tc.function.name, tc.function.name)
                try:
                    args = json.loads(tc.function.arguments)
                except Exception:
                    args = {}
                yield f"data: {json.dumps({'type': 'tool_call', 'name': tc.function.name, 'label': label, 'input': args}, ensure_ascii=False)}\n\n"
                result = await _exec_tool(user_id, tc.function.name, args)
                yield f"data: {json.dumps({'type': 'tool_done', 'name': tc.function.name, 'label': label}, ensure_ascii=False)}\n\n"
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })
            continue  # 继续循环

        # 无工具调用 → 流式输出最终文本
        stream = await client.chat.completions.create(
            model=settings.ai.model,
            messages=messages,
            max_tokens=2000,
            temperature=0.7,
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield f"data: {json.dumps({'type': 'token', 'content': delta})}\n\n"
        return

    yield f"data: {json.dumps({'type': 'error', 'detail': '工具调用轮次超限'})}\n\n"


# ── 主生成器 ──────────────────────────────────────────────────────────────────

async def _stream(
    user_id: int, user_name: str, body: ChatRequest
) -> AsyncGenerator[str, None]:
    settings = get_settings()

    import app.db.session as _sess
    if _sess._engine is None:
        _sess._build_engine()

    async with _sess._SessionLocal() as db:
        # 查项目 + 事件
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
            .order_by(CalendarEvent.date).limit(10)
        )
        events = ev_result.scalars().all()

        # 获取或新建会话
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
            session = ConversationSession(user_id=user_id, title=body.message[:50])
            db.add(session)
            await db.flush()

        hist_res = await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.session_id == session.id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(10)
        )
        history = list(reversed(hist_res.scalars().all()))

        db.add(ConversationMessage(session_id=session.id, role="user", content=body.message))
        await db.commit()
        session_id = session.id

    yield f"data: {json.dumps({'type': 'session_id', 'session_id': session_id})}\n\n"

    system_prompt = _build_system_prompt(user_name, projects, events)

    use_anthropic = (
        settings.ai.provider == "minimax"
        or "anthropic" in settings.ai.base_url.lower()
    )

    full_reply = ""
    tool_calls_summary = []

    try:
        if use_anthropic:
            # Anthropic 格式 messages（不含 system）
            anthr_messages = []
            for h in history:
                anthr_messages.append({"role": h.role if h.role != "assistant" else "assistant", "content": h.content})
            anthr_messages.append({"role": "user", "content": body.message})

            async for evt_str in _loop_anthropic(user_id, system_prompt, anthr_messages, settings):
                yield evt_str
                # 收集 token 存 full_reply
                try:
                    evt = json.loads(evt_str[6:])
                    if evt.get("type") == "token":
                        full_reply += evt["content"]
                    elif evt.get("type") == "tool_done":
                        tool_calls_summary.append(evt["label"])
                except Exception:
                    pass

        else:
            # OpenAI 格式 messages（含 system）
            oa_messages = [{"role": "system", "content": system_prompt}]
            for h in history:
                oa_messages.append({"role": h.role, "content": h.content})
            oa_messages.append({"role": "user", "content": body.message})

            async for evt_str in _loop_openai(user_id, oa_messages, settings):
                yield evt_str
                try:
                    evt = json.loads(evt_str[6:])
                    if evt.get("type") == "token":
                        full_reply += evt["content"]
                    elif evt.get("type") == "tool_done":
                        tool_calls_summary.append(evt["label"])
                except Exception:
                    pass

        # 保存 AI 回复
        if full_reply:
            async with _sess._SessionLocal() as db2:
                db2.add(ConversationMessage(
                    session_id=session_id,
                    role="assistant",
                    content=full_reply,
                ))
                await db2.commit()

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    except BaseException as e:
        detail = str(e)[:200] or type(e).__name__
        yield f"data: {json.dumps({'type': 'error', 'detail': f'AI 服务暂时不可用：{detail}'})}\n\n"


@router.post("/chat")
async def chat(
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    return StreamingResponse(
        _stream(current_user.id, current_user.username, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
