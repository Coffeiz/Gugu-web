"""Agent API interactions endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ownership import get_owned
from app.core.security import get_current_user
from app.db.session import get_db
from app.models import ConversationSession, User
from app.services import interactions

router = APIRouter()


class InteractionResponseRequest(BaseModel):
    token: str
    event_id: Optional[str] = None

class InteractionTextRequest(BaseModel):
    text: str
    event_id: Optional[str] = None

class SecretInteractionRequest(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)

@router.get("/sessions/{session_id}/interactions")
async def list_session_interactions(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出会话交互历史；活动项带一次性 token，历史项只用于恢复气泡。"""
    session = await get_owned(db, ConversationSession, session_id, current_user.id)
    if session is None:
        raise HTTPException(404, "会话不存在")
    return {"items": await interactions.list_history(db, user_id=current_user.id, session_id=session_id)}

@router.get("/interactions/{prompt_id}/session")
async def get_interaction_session(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """解析非授权 prompt 深链，只向其 owner 返回所属会话 ID。"""
    prompt = await interactions.get_user_prompt(
        db, user_id=current_user.id, prompt_id=prompt_id,
    )
    if prompt is None:
        raise HTTPException(404, "交互不存在")
    schema = prompt.schema_json if isinstance(prompt.schema_json, dict) else {}
    context = schema.get("context") if isinstance(schema.get("context"), dict) else {}
    target = context.get("secret_target")
    if not schema.get("secret_fields") or not isinstance(target, dict) or target.get("kind") != "mcp_credentials":
        raise HTTPException(404, "交互不存在")
    return {"session_id": prompt.session_id}

@router.post("/interactions/{prompt_id}/respond")
async def respond_interaction(
    prompt_id: int,
    body: InteractionResponseRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费一次交互动作，返回 Agent bridge 用的受控结果。"""
    try:
        result = await interactions.consume_action(
            db,
            user_id=current_user.id,
            prompt_id=prompt_id,
            token=body.token,
            event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    return result

@router.post("/interactions/{prompt_id}/secrets")
async def submit_secret_interaction(
    prompt_id: int,
    body: SecretInteractionRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """通用敏感字段入口；业务目标负责把值写入自己的加密存储。"""
    prompt = await interactions.get_user_prompt(
        db, user_id=current_user.id, prompt_id=prompt_id, for_update=True,
    )
    if prompt is None:
        raise HTTPException(404, "敏感信息输入不存在")
    schema = prompt.schema_json if isinstance(prompt.schema_json, dict) else {}
    context = schema.get("context") if isinstance(schema.get("context"), dict) else {}
    target = context.get("secret_target")
    if not isinstance(target, dict) or target.get("kind") != "mcp_credentials":
        raise HTTPException(400, "当前敏感信息交互没有可用的业务处理器")
    from app.services.mcp_credentials import consume_mcp_secret_prompt
    return await consume_mcp_secret_prompt(
        prompt, body.values, user=current_user, db=db,
    )

@router.post("/interactions/{prompt_id}/secrets/cancel")
async def cancel_secret_interaction(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """登录态 Web 取消 secret prompt；历史 IM 群会话也允许走此私密入口。"""
    prompt = await interactions.get_user_prompt(
        db, user_id=current_user.id, prompt_id=prompt_id,
    )
    if prompt is None:
        raise HTTPException(404, "凭据输入不存在")
    from app.services.mcp_secret_inputs import cancel_mcp_secret_prompt_web

    result = await cancel_mcp_secret_prompt_web(db, prompt=prompt, user_id=current_user.id)
    await db.commit()
    return result

@router.post("/interactions/{prompt_id}/resume")
async def resume_interaction(
    prompt_id: int,
    body: InteractionResponseRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费工具确认或 ask_user 选择，唤醒仍在等待中的原 Agent Run。"""
    try:
        result = await interactions.consume_action(
            db,
            user_id=current_user.id,
            prompt_id=prompt_id,
            token=body.token,
            event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    if not result.get("context", {}).get("tool_call_id"):
        raise HTTPException(409, "该交互不支持恢复原任务")
    resolved = result.get("result") if isinstance(result.get("result"), dict) else {}
    if resolved.get("status") == "error":
        raise HTTPException(409, str(resolved.get("text") or "确认未生效，请重新发起操作。"))
    return {
        "ok": True,
        "session_id": result["session_id"],
        "status": resolved.get("status"),
        "option_id": result.get("option_id"),
    }

@router.post("/interactions/{prompt_id}/resume-text")
async def resume_text_interaction(
    prompt_id: int,
    body: InteractionTextRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """消费 ask_user 的文本回答，唤醒仍在等待中的原 Agent Run。"""
    try:
        result = await interactions.consume_text(
            db, user_id=current_user.id, prompt_id=prompt_id,
            text=body.text, event_id=body.event_id,
        )
    except LookupError:
        raise HTTPException(404, "交互不存在")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    if not result.get("context", {}).get("tool_call_id"):
        raise HTTPException(409, "该交互不支持恢复原任务")
    return {"ok": True, "session_id": result["session_id"]}
