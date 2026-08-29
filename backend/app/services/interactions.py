"""统一交互 Prompt/Action 生命周期服务。"""
from __future__ import annotations

import asyncio
from datetime import timedelta
import hashlib
import json
import secrets

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.tz import now_utc
from app.models import ConversationSession, InteractionAction, InteractionPrompt


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _schema_dict(value: object) -> dict:
    """统一读取 JSON 列，兼容历史库中被序列化为字符串的记录。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


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
    allow_text_input: bool = False,
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
        schema_json={
            "options": options,
            "allow_text_input": bool(allow_text_input),
            "context": dict(context or {}),
        },
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


async def create_agent_prompt(
    *,
    user_id,
    session_id: int | None,
    tool_call_id: str,
    tool_name: str,
    payload: dict,
) -> tuple[InteractionPrompt, list[dict]] | None:
    """把 ``ask_user`` 的工具结果绑定到当前 Agent session。"""
    from app.core.redaction import diag_log_raw

    def reject(reason: str):
        # 这里只记录固定原因，不记录标题、正文、选项或用户身份。
        diag_log_raw("agent.interactions.ask_user.rejected", reason)
        return None

    if session_id is None or not isinstance(payload, dict):
        return reject("missing_session_or_payload")
    kind = str(payload.get("kind") or "choice")
    if kind not in {"choice", "question", "form"}:
        return reject("invalid_kind")
    options = payload.get("options") if isinstance(payload.get("options"), list) else []
    if kind == "choice" and not 2 <= len(options) <= 8:
        return reject("invalid_choice_count")
    if kind != "choice" and len(options) > 8:
        return reject("invalid_option_count")
    normalized = []
    for option in options:
        if not isinstance(option, dict):
            return reject("invalid_option_type")
        option_id = str(option.get("id") or "").strip()
        label = str(option.get("label") or "").strip()
        if not option_id or not label or len(option_id) > 64 or len(label) > 120:
            return reject("invalid_option_fields")
        normalized.append({"id": option_id, "label": label, "action_type": "choice"})
    title = str(payload.get("title") or "需要你的回答").strip()[:120]
    body = str(payload.get("body") or "").strip()[:1000]
    context = {
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "allow_text_input": bool(payload.get("allow_text_input", False)),
    }
    from app.db import session as db_session
    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return reject("database_session_unavailable")
    async with db_session._SessionLocal() as db:
        prompt, rendered = await create_prompt(
            db,
            user_id=user_id,
            session_id=session_id,
            kind=kind,
            title=title,
            body=body,
            options=normalized,
            context=context,
            allow_text_input=bool(payload.get("allow_text_input", False)),
        )
        await db.commit()
        return prompt, rendered


async def create_goal_mode_prompt(*, user_id, session_id: int | None) -> tuple[InteractionPrompt, list[dict]] | None:
    """创建轮次达到上限后的当前 Run 继续选择。"""
    if session_id is None:
        return None
    from app.db import session as db_session

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return None
    async with db_session._SessionLocal() as db:
        prompt, rendered = await create_prompt(
            db,
            user_id=user_id,
            session_id=session_id,
            kind="choice",
            title="要继续这个长任务吗？",
            body="本次已经达到轮次上限。解除本轮限制后会继续当前任务；仍可随时发送 /stop。",
            options=[
                {"id": "continue", "label": "解除本轮调用限制", "action_type": "run_unlimited"},
                {"id": "cancel", "label": "先停在这里", "action_type": "cancel"},
            ],
            context={"run_unlimited": True},
        )
        await db.commit()
        return prompt, rendered


async def create_tool_budget_prompt(*, user_id, session_id: int | None) -> tuple[InteractionPrompt, list[dict]] | None:
    """工具步骤达到普通 run 上限时，询问是否仅解除本轮工具次数限制。"""
    if session_id is None:
        return None
    from app.db import session as db_session

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return None
    async with db_session._SessionLocal() as db:
        prompt, rendered = await create_prompt(
            db,
            user_id=user_id,
            session_id=session_id,
            kind="choice",
            title="步骤较多，要继续吗？",
            body="本轮已达到普通工具调用次数。选择继续只解除当前会话的工具次数限制，不会创建持续目标任务；也可以先停在这里。",
            options=[
                {"id": "continue", "label": "继续执行", "action_type": "unlimited_mode"},
                {"id": "cancel", "label": "先停在这里", "action_type": "cancel"},
            ],
            context={"unlimited_mode": True},
        )
        await db.commit()
        return prompt, rendered


async def wait_for_resolution(
    *, user_id, prompt_id: int, timeout_seconds: float = 600, heartbeat=None,
    cancel_check=None,
) -> dict | None:
    """等待交互被消费，让原 Agent Run 在同一协程中继续。

    ``cancel_check`` 用于 IM 的实时取消信号。交互等待期间没有模型 token 边界，
    不能只依赖普通生成循环的取消检查；命中后先关闭 Prompt，再让原 Run 收尾。
    """
    from app.db import session as db_session

    db_session.ensure_engine()
    if db_session._SessionLocal is None:
        return None
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    next_heartbeat = 0.0
    while asyncio.get_running_loop().time() < deadline:
        now = asyncio.get_running_loop().time()
        if cancel_check is not None and await cancel_check():
            async with db_session._SessionLocal() as db:
                prompt = await db.scalar(select(InteractionPrompt).where(
                    InteractionPrompt.id == prompt_id,
                    InteractionPrompt.user_id == user_id,
                ))
                if prompt is not None and prompt.status == "active":
                    prompt.status = "cancelled"
                    prompt.resolved_at = now_utc()
                    await db.commit()
            return {"status": "cancelled", "prompt_id": prompt_id}
        if heartbeat is not None and now >= next_heartbeat:
            await heartbeat()
            next_heartbeat = now + 20
        async with db_session._SessionLocal() as db:
            prompt = await db.scalar(select(InteractionPrompt).where(
                InteractionPrompt.id == prompt_id,
                InteractionPrompt.user_id == user_id,
            ))
            if prompt is None:
                return None
            schema = _schema_dict(prompt.schema_json)
            resolved = schema.get("resolved_result")
            if prompt.status == "resolved" and isinstance(resolved, dict):
                return resolved
            if prompt.status in {"cancelled", "expired"}:
                return None
        await asyncio.sleep(0.25)
    return None


def _replace_pending_tool_result(message, *, tool_call_id: str, result: dict) -> bool:
    source_blocks = message.content_json
    if not isinstance(source_blocks, list):
        return False
    blocks = [dict(block) if isinstance(block, dict) else block for block in source_blocks]
    changed = False
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_result":
            continue
        current_id = str(block.get("tool_call_id") or block.get("tool_use_id") or "")
        if current_id == tool_call_id:
            block["content"] = json.dumps(result, ensure_ascii=False)
            block.pop("is_error", None)
            changed = True
    if changed:
        message.content_json = blocks
    return changed


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
    context = dict(action.context_json or {})
    is_cancel = action.option_id == "cancel" or action.action_type == "cancel"
    command_action = str(context.get("command_action") or "")
    if command_action == "workspace_delete" and not is_cancel:
        from app.services.workspaces import delete_workspace, get_workspace

        workspace_id = context.get("workspace_id")
        workspace = await get_workspace(db, user_id, workspace_id)
        if workspace is None:
            result_status = "error"
            result_text = "工作区不存在，或已经被删除。"
        else:
            await delete_workspace(db, user_id, workspace.id)
            result_status = "confirmed"
            result_text = f"已删除工作区「{workspace.name}」（ID {workspace.id}），项目和文件未受影响。"
    else:
        result_status = "cancelled" if is_cancel else "selected"
        result_text = next(
            (
                str(item.get("label") or action.option_id)
                for item in _schema_dict(prompt.schema_json).get("options", [])
                if isinstance(item, dict) and str(item.get("id") or "") == action.option_id
            ),
            action.option_id,
        )
    # ``run_unlimited`` 只由当前 Agent 协程消费，不写入 session_context。
    # 持久化的无限模式只能通过显式 /unlimited 命令开启。
    if context.get("unlimited_mode") and action.option_id == "continue":
        session = await db.scalar(select(ConversationSession).where(
            ConversationSession.id == prompt.session_id,
            ConversationSession.user_id == user_id,
        ))
        if session is None:
            raise LookupError("会话不存在")
        session_context = dict(session.session_context or {})
        session_context["unlimited_mode"] = True
        if session_context.get("goal_mode") and not session_context.get("goal_text"):
            session_context["goal_mode"] = False
        session.session_context = session_context
    result = {
        "kind": prompt.kind,
        "status": result_status,
        "prompt_id": prompt.id,
        "option_id": action.option_id,
        "value": action.option_id,
        "text": result_text,
    }
    if prompt.kind == "confirm" and result_status != "error":
        if action.option_id == "confirm":
            result.update({
                "status": "confirmed",
                "confirm": True,
                "confirm_token": context.get("confirm_token"),
            })
        else:
            result.update({"status": "cancelled", "confirm": False})
    tool_call_id = str(context.get("tool_call_id") or "")
    if tool_call_id:
        from app.models import ConversationMessage
        rows = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.session_id == prompt.session_id)
        )).scalars().all()
        for message in rows:
            if _replace_pending_tool_result(message, tool_call_id=tool_call_id, result=result):
                break
    prompt.schema_json = {**_schema_dict(prompt.schema_json), "resolved_result": result}
    await db.commit()
    return {
        "prompt_id": prompt.id,
        "session_id": prompt.session_id,
        "kind": prompt.kind,
        "option_id": action.option_id,
        "action_type": action.action_type,
        "context": context,
        "result": result,
    }


async def consume_text(
    db: AsyncSession,
    *,
    user_id,
    prompt_id: int,
    text: str,
    event_id: str | None = None,
) -> dict:
    """消费允许文本回答的 Prompt；文本回答同样只能恢复一次。"""
    now = now_utc()
    prompt = await db.scalar(select(InteractionPrompt).where(
        InteractionPrompt.id == prompt_id,
        InteractionPrompt.user_id == user_id,
    ).with_for_update())
    if prompt is None:
        raise LookupError("交互不存在")
    if prompt.status != "active" or prompt.expires_at <= now:
        prompt.status = "expired"
        prompt.resolved_at = now
        await db.commit()
        raise ValueError("交互已过期")
    if not bool(_schema_dict(prompt.schema_json).get("allow_text_input")):
        raise ValueError("该交互不接受文本回答")
    text = str(text or "").strip()
    if not text or len(text) > 2000:
        raise ValueError("回答不能为空或过长")
    # 文本型 Prompt 可能没有 Action，context 存在 Prompt schema 的内部字段中。
    schema = _schema_dict(prompt.schema_json)
    context = dict(schema.get("context") or {})
    result = {
        "kind": prompt.kind,
        "status": "answered",
        "prompt_id": prompt.id,
        "option_id": None,
        "value": None,
        "text": text,
    }
    tool_call_id = str(context.get("tool_call_id") or "")
    if tool_call_id:
        from app.models import ConversationMessage
        rows = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.session_id == prompt.session_id)
        )).scalars().all()
        for message in rows:
            if _replace_pending_tool_result(message, tool_call_id=tool_call_id, result=result):
                break
    prompt.status = "resolved"
    prompt.resolved_at = now
    prompt.schema_json = {**schema, "resolved_result": result}
    await db.commit()
    return {"prompt_id": prompt.id, "session_id": prompt.session_id, "kind": prompt.kind,
            "context": context, "result": result, "event_id": event_id}


async def consume_choice_text(
    db: AsyncSession,
    *,
    user_id,
    session_id: int,
    text: str,
    event_id: str | None = None,
) -> dict | None:
    """把 IM 降级文案中的序号/选项文字消费为当前 choice Prompt。

    这是原生按钮不可用时的同一条交互恢复路径。只匹配指定 session 最近的活动
    ``choice``，不会把普通消息误当成交互，也不会跨会话消费 Prompt。
    """
    value = str(text or "").strip()
    if not value or len(value) > 200:
        return None
    now = now_utc()
    prompt = await db.scalar(
        select(InteractionPrompt).where(
            InteractionPrompt.user_id == user_id,
            InteractionPrompt.session_id == session_id,
            InteractionPrompt.kind == "choice",
            InteractionPrompt.status == "active",
            InteractionPrompt.expires_at > now,
        ).order_by(InteractionPrompt.created_at.desc()).with_for_update()
    )
    if prompt is None:
        return None
    schema = _schema_dict(prompt.schema_json)
    options = [item for item in schema.get("options", []) if isinstance(item, dict)]
    if not options:
        return None
    selected = None
    if value.isdigit():
        index = int(value)
        if 1 <= index <= len(options):
            selected = options[index - 1]
    if selected is None:
        folded = value.casefold()
        selected = next(
            (
                item for item in options
                if folded in {
                    str(item.get("id") or "").strip().casefold(),
                    str(item.get("label") or "").strip().casefold(),
                }
            ),
            None,
        )
    if selected is None:
        return None
    option_id = str(selected.get("id") or "").strip()
    action = await db.scalar(
        select(InteractionAction).where(
            InteractionAction.prompt_id == prompt.id,
            InteractionAction.option_id == option_id,
            InteractionAction.status == "pending",
            InteractionAction.expires_at > now,
        ).with_for_update()
    )
    if action is None:
        return None
    action.status = "consumed"
    action.consumed_at = now
    action.consumed_event_id = event_id
    prompt.status = "resolved"
    prompt.resolved_at = now
    context = dict(action.context_json or {})
    result = {
        "kind": prompt.kind,
        "status": "selected",
        "prompt_id": prompt.id,
        "option_id": option_id,
        "value": option_id,
        "text": str(selected.get("label") or option_id),
    }
    tool_call_id = str(context.get("tool_call_id") or "")
    if tool_call_id:
        from app.models import ConversationMessage
        rows = (await db.execute(
            select(ConversationMessage).where(ConversationMessage.session_id == prompt.session_id)
        )).scalars().all()
        for message in rows:
            if _replace_pending_tool_result(message, tool_call_id=tool_call_id, result=result):
                break
    prompt.schema_json = {**schema, "resolved_result": result}
    await db.commit()
    return {
        "prompt_id": prompt.id,
        "session_id": prompt.session_id,
        "kind": prompt.kind,
        "option_id": option_id,
        "action_type": action.action_type,
        "context": context,
        "result": result,
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
                    (str(item.get("label") or "") for item in _schema_dict(prompt.schema_json).get("options", [])
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
            # 交互由某次工具调用暂停产生。前端恢复时间线时需要这个关联，
            # 才能稳定保持“工具气泡 -> 交互气泡”的实时顺序。
            "tool_call_id": str((schema.get("context") or {}).get("tool_call_id") or "") or None,
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
        schema_options = _schema_dict(prompt.schema_json).get("options", [])
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
            # 交互由某次工具调用暂停产生。前端恢复时间线时需要这个关联，
            # 才能稳定保持“工具气泡 -> 交互气泡”的实时顺序。
            "tool_call_id": str(_schema_dict(prompt.schema_json).get("context", {}).get("tool_call_id") or "") or None,
            "options": options,
            "resolved": prompt.status != "active" or prompt.expires_at <= now,
            "selected_option_id": selected,
            "created_at": prompt.created_at.isoformat(),
        })
    if changed:
        await db.commit()
    return result


async def create_tool_confirmation(
    *, user_id, session_id: int | None, tool_name: str, tool_call_id: str | None = None,
    result,
) -> dict | None:
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
    confirm_token = payload.get("confirm_token")
    context = {
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "confirm_token": confirm_token if isinstance(confirm_token, str) else None,
    }
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
            context=context,
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
