"""统一交互 Prompt/Action 生命周期服务。"""
from __future__ import annotations

from datetime import timedelta
import hashlib
import secrets

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import ConversationSession, InteractionAction, InteractionPrompt


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def create_prompt(
    db: AsyncSession,
    *,
    user_id,
    session_id: int,
    kind: str,
    title: str,
    body: str,
    options: list[dict],
    context: dict | None = None,
    expires_minutes: int = 10,
) -> tuple[InteractionPrompt, list[dict]]:
    """创建 Prompt，并返回仅用于当前响应的明文 action token。"""
    session = await db.scalar(
        select(ConversationSession).where(
            ConversationSession.id == session_id,
            ConversationSession.user_id == user_id,
        )
    )
    if session is None:
        raise LookupError("会话不存在")

    now = now_utc()
    expires_at = now + timedelta(minutes=max(1, min(expires_minutes, 30)))
    await db.execute(
        update(InteractionPrompt)
        .where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id == session_id,
            InteractionPrompt.status == "active",
        )
        .values(status="cancelled", resolved_at=now)
    )
    prompt = InteractionPrompt(
        user_id=user_id,
        session_id=session_id,
        kind=kind,
        title=title[:300],
        body=body,
        schema_json={"options": options},
        expires_at=expires_at,
    )
    db.add(prompt)
    await db.flush()

    rendered: list[dict] = []
    for option in options:
        token = secrets.token_urlsafe(24)
        action = InteractionAction(
            prompt_id=prompt.id,
            token_hash=_hash_token(token),
            action_type=str(option.get("action_type") or kind),
            option_id=str(option.get("id") or ""),
            context_json=dict(context or {}),
            expires_at=expires_at,
        )
        db.add(action)
        rendered.append({"id": action.option_id, "label": str(option.get("label") or ""), "token": token})
    await db.flush()
    return prompt, rendered


async def consume_action(
    db: AsyncSession,
    *,
    user_id,
    prompt_id: int,
    token: str,
    event_id: str | None = None,
) -> dict:
    """原子消费动作；返回给 Agent bridge 的受控结果，不返回 token。"""
    now = now_utc()
    prompt = await db.scalar(
        select(InteractionPrompt).where(
            InteractionPrompt.id == prompt_id,
            InteractionPrompt.user_id == user_id,
        )
    )
    if prompt is None:
        raise LookupError("交互不存在")
    if prompt.status != "active" or prompt.expires_at <= now:
        prompt.status = "expired"
        prompt.resolved_at = now
        await db.commit()
        raise ValueError("交互已过期")

    action = await db.scalar(
        select(InteractionAction).where(
            InteractionAction.prompt_id == prompt_id,
            InteractionAction.token_hash == _hash_token(token),
        ).with_for_update()
    )
    if action is None or action.status != "pending" or action.expires_at <= now:
        raise ValueError("动作无效或已使用")
    action.status = "consumed"
    action.consumed_at = now
    action.consumed_event_id = event_id
    prompt.status = "resolved"
    prompt.resolved_at = now
    await db.commit()
    return {
        "prompt_id": prompt.id,
        "session_id": prompt.session_id,
        "kind": prompt.kind,
        "option_id": action.option_id,
        "action_type": action.action_type,
        "context": dict(action.context_json or {}),
    }


async def list_active(db: AsyncSession, *, user_id, session_id: int) -> list[dict]:
    now = now_utc()
    rows = (await db.execute(
        select(InteractionPrompt).where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id == session_id,
            InteractionPrompt.status == "active",
            InteractionPrompt.expires_at > now,
        ).order_by(InteractionPrompt.created_at.desc())
    )).scalars().all()
    result: list[dict] = []
    for prompt in rows:
        actions = (await db.execute(
            select(InteractionAction).where(
                InteractionAction.prompt_id == prompt.id,
                InteractionAction.status == "pending",
                InteractionAction.expires_at > now,
            ).order_by(InteractionAction.id)
        )).scalars().all()
        options = []
        for action in actions:
            token = secrets.token_urlsafe(24)
            action.token_hash = _hash_token(token)
            options.append({
                "id": action.option_id,
                "label": next(
                    (str(item.get("label") or "") for item in (prompt.schema_json or {}).get("options", [])
                     if str(item.get("id") or "") == action.option_id),
                    action.option_id,
                ),
                "token": token,
            })
        result.append({
            "id": prompt.id,
            "session_id": prompt.session_id,
            "kind": prompt.kind,
            "title": prompt.title,
            "body": prompt.body,
            "options": options,
            "expires_at": prompt.expires_at.isoformat(),
        })
    if result:
        await db.commit()
    return result


async def list_history(db: AsyncSession, *, user_id, session_id: int) -> list[dict]:
    """返回会话全部交互气泡；活动项轮换 token，已完成项只保留展示数据。"""
    now = now_utc()
    prompts = (await db.execute(
        select(InteractionPrompt).where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id == session_id,
        ).order_by(InteractionPrompt.created_at)
    )).scalars().all()
    result: list[dict] = []
    changed = False
    for prompt in prompts:
        actions = (await db.execute(
            select(InteractionAction).where(InteractionAction.prompt_id == prompt.id).order_by(InteractionAction.id)
        )).scalars().all()
        options = []
        selected = None
        schema_options = (prompt.schema_json or {}).get("options", [])
        for action in actions:
            label = next(
                (str(item.get("label") or "") for item in schema_options
                 if str(item.get("id") or "") == action.option_id),
                action.option_id,
            )
            if action.status == "consumed":
                selected = action.option_id
                continue
            if prompt.status == "active" and action.expires_at > now and action.status == "pending":
                token = secrets.token_urlsafe(24)
                action.token_hash = _hash_token(token)
                changed = True
                options.append({"id": action.option_id, "label": label, "token": token})
        result.append({
            "id": prompt.id,
            "session_id": prompt.session_id,
            "kind": prompt.kind,
            "title": prompt.title,
            "body": prompt.body,
            "options": options,
            "resolved": prompt.status != "active" or prompt.expires_at <= now,
            "selected_option_id": selected,
            "created_at": prompt.created_at.isoformat(),
        })
    if changed:
        await db.commit()
    return result


async def create_tool_confirmation(*, user_id, session_id: int | None, tool_name: str, result) -> dict | None:
    """把破坏性工具的 ``needs_confirm`` 结果桥接为统一交互事件。

    工具仍保留原确认门和模型可见的结果；这里仅额外创建网页/IM 可消费的短时按钮。
    明文 action token 只返回给当前事件，不写日志、不落库。
    """
    if session_id is None:
        return None
    # 统一桥只接收工具注册表明确标记为 destructive 的确认门，避免普通业务结果
    # 偶然带 needs_confirm 字段时也被渲染成危险操作按钮。
    try:
        from agent.tools import registry
        tool = registry.get(tool_name)
        if tool is None or not tool.destructive:
            return None
    except Exception:
        return None
    import json
    if isinstance(result, str):
        try:
            payload = json.loads(result)
        except (TypeError, ValueError):
            return None
    elif isinstance(result, dict):
        payload = result
    else:
        return None
    if not isinstance(payload, dict) or not payload.get("needs_confirm"):
        return None

    from app.db import session as db_session
    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return None
    summary = str(payload.get("summary") or payload.get("instruction") or "请确认是否继续这项操作")
    async with db_session._SessionLocal() as db:
        prompt, actions = await create_prompt(
            db,
            user_id=user_id,
            session_id=session_id,
            kind="confirm",
            title=f"确认：{tool_name}",
            body=summary,
            options=[
                {"id": "confirm", "label": "确认", "action_type": "confirm"},
                {"id": "cancel", "label": "取消", "action_type": "cancel"},
            ],
            context={"tool_name": tool_name},
        )
        await db.commit()
        return {
            "prompt_id": prompt.id,
            "kind": prompt.kind,
            "title": prompt.title,
            "body": prompt.body,
            "options": actions,
            "expires_at": prompt.expires_at.isoformat(),
        }
