"""会话生命周期后台任务。

标题、会话摘要和它们的异步落库属于会话生命周期，不属于模型执行器或某个
传输网关。Web、IM 和其它入口都通过这里触发，避免入口之间互相导入。
"""
from __future__ import annotations

import asyncio


# 后台任务引用，防止 fire-and-forget 的标题/摘要生成被垃圾回收。
_background_tasks: set[asyncio.Task] = set()


def build_title_prompt(user_msg: str, ai_reply: str) -> str:
    """构造新会话标题提示词，标题语言跟随当前对话语言。"""
    return (
        "根据下面这段对话，用一句话起一个简短的标题（10字以内，不含引号和标点符号）。"
        "标题必须使用与用户和咕咕交流相同的语言；如果对话主要使用英文，就用英文输出；"
        "如果主要使用日文，就用日文输出。不要因为本提示词使用中文而输出中文。"
        "只输出标题本身，不要任何解释。\n"
        f"用户：{user_msg[:150]}\n咕咕：{ai_reply[:300]}"
    )


async def generate_title(user_msg: str, ai_reply: str, settings, use_anthropic: bool, ai=None) -> str:
    """用 LLM 为新对话起标题；失败时回退到截断用户消息。"""
    prompt = build_title_prompt(user_msg, ai_reply)
    from agent import providers
    from agent.llm.modelctx import effective_ai

    ai = ai or effective_ai(settings)
    provider_adapter = providers.adapter_for(ai)
    try:
        if use_anthropic:
            import httpx

            client = providers.build_anthropic_client(ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_anthropic_thinking_params(ai)
            resp = await client.messages.create(
                model=ai.model,
                max_tokens=40,
                messages=[{"role": "user", "content": prompt}],
                **extra,
            )
            text = "".join(
                getattr(block, "text", "")
                for block in resp.content
                if getattr(block, "type", "") == "text"
            )
            return (text.strip()[:30]) or user_msg[:20]

        import httpx

        client = providers.build_openai_client(ai, httpx.Timeout(10.0))
        extra = provider_adapter.build_openai_thinking_kwargs(ai)
        resp = await client.chat.completions.create(
            model=ai.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=40,
            **extra,
        )
        return (resp.choices[0].message.content or "").strip()[:30] or user_msg[:20]
    except Exception:
        return user_msg[:20]


async def generate_summary(convo: str, settings, use_anthropic: bool) -> str:
    """用 LLM 给一段会话生成一句话总结，失败回空且不覆盖旧总结。"""
    prompt = (
        "用一句话（20字以内）概括下面这段对话主要在聊什么 / 在做什么，"
        "供日后检索和接着聊时一眼认出。只输出那句话，不要引号、不要解释。\n\n"
        f"{convo[:1500]}"
    )
    from agent import providers
    from agent.llm.modelctx import effective_ai

    ai = effective_ai(settings)
    provider_adapter = providers.adapter_for(ai)
    try:
        if use_anthropic:
            import httpx

            client = providers.build_anthropic_client(ai, httpx.Timeout(10.0))
            extra = provider_adapter.build_anthropic_thinking_params(ai)
            resp = await client.messages.create(
                model=ai.model,
                max_tokens=80,
                messages=[{"role": "user", "content": prompt}],
                **extra,
            )
            text = "".join(
                getattr(block, "text", "")
                for block in resp.content
                if getattr(block, "type", "") == "text"
            )
            return text.strip().strip('"「」')[:120]

        import httpx

        client = providers.build_openai_client(ai, httpx.Timeout(10.0))
        extra = provider_adapter.build_openai_thinking_kwargs(ai)
        resp = await client.chat.completions.create(
            model=ai.model,
            max_tokens=80,
            messages=[{"role": "user", "content": prompt}],
            **extra,
        )
        return (resp.choices[0].message.content or "").strip().strip('"「」')[:120]
    except Exception:
        return ""


def schedule_title(
    user_id,
    session_id,
    user_msg: str,
    reply_text: str,
    settings,
    use_anthropic: bool,
) -> None:
    """异步生成新会话标题，不阻塞主回复。"""
    task = asyncio.create_task(
        generate_title_bg(user_id, session_id, user_msg, reply_text, settings, use_anthropic)
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def generate_title_bg(
    user_id,
    session_id,
    user_msg: str,
    reply_text: str,
    settings,
    use_anthropic: bool,
) -> None:
    """生成标题并以原子条件更新落库，手动改名永远优先。"""
    try:
        new_title = await generate_title(user_msg, reply_text, settings, use_anthropic)
        if not new_title:
            return

        import app.db.session as _sess
        from app.models import ConversationSession
        from sqlalchemy import update

        async with _sess._SessionLocal() as db:
            result = await db.execute(
                update(ConversationSession)
                .where(
                    ConversationSession.id == session_id,
                    ConversationSession.title_locked.is_(False),
                )
                .values(title=new_title)
            )
            if result.rowcount != 1:
                return
            await db.commit()

        from app.core import events

        await events.publish(user_id, "sessions", session_id=session_id, title=new_title)
    except Exception:
        pass


def schedule_summary(user_id, session_id, force: bool, settings, use_anthropic: bool) -> None:
    """异步生成或刷新会话摘要，不阻塞主回复。"""
    task = asyncio.create_task(
        generate_summary_bg(user_id, session_id, force, settings, use_anthropic)
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def generate_summary_bg(
    user_id,
    session_id,
    force: bool,
    settings,
    use_anthropic: bool,
) -> None:
    """按刷新策略生成会话摘要并写回数据库。"""
    try:
        import app.db.session as _sess
        from agent.context.audit import session_scope, summary_change
        from app.models import ConversationMessage, ConversationSession
        from sqlalchemy import desc, func, select

        async with _sess._SessionLocal() as db:
            count = (
                await db.execute(
                    select(func.count())
                    .select_from(ConversationMessage)
                    .where(
                        ConversationMessage.session_id == session_id,
                        ConversationMessage.content_json.is_(None),
                    )
                )
            ).scalar_one()
            if not force and (count < 4 or count % 6 != 0):
                return
            rows = (
                await db.execute(
                    select(ConversationMessage)
                    .where(
                        ConversationMessage.session_id == session_id,
                        ConversationMessage.content_json.is_(None),
                    )
                    .order_by(desc(ConversationMessage.created_at))
                    .limit(12)
                )
            ).scalars().all()
            rows = [message for message in reversed(rows) if message.content]

        if not rows:
            return
        convo = "\n".join(
            f"{'用户' if message.role == 'user' else '咕咕'}：{(message.content or '')[:200]}"
            for message in rows
        )
        summary = await generate_summary(convo, settings, use_anthropic)
        if not summary:
            return

        async with _sess._SessionLocal() as db:
            session = await db.get(ConversationSession, session_id)
            if session:
                audit_scope = session_scope(session)
                audit_scope.pop("source", None)
                summary_change(
                    source="conversation_session_summary_bg",
                    old=session.summary,
                    new=summary,
                    trigger="force" if force else "periodic",
                    **audit_scope,
                )
                session.summary = summary
                await db.commit()
    except Exception:
        pass
