"""Agent API misc endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User

router = APIRouter()


@router.get("/ui-labels")
async def get_ui_labels(current_user: User = Depends(get_current_user)):
    """聊天前端用的「状态显示名」——目前只有「思考中」三个点的文字是前端态（无 SSE 事件），
    工具名/复查前缀都由后端在 tool_call 事件里直接下发。返回解析后的特殊状态名（已套用后台覆盖）。"""
    import re
    from app.core.config import get_settings
    from agent.core import SPECIAL_STATE_LABELS
    ov = getattr(getattr(get_settings(), "state_labels", None), "overrides", None) or {}
    merged = {**SPECIAL_STATE_LABELS, **{k: v for k, v in ov.items() if k.startswith("_") and v}}

    def _split(raw: str) -> list[str]:
        # 命名可含多个候选（| 或换行分隔）→ 返回数组，前端每次随机取一个
        return [p.strip() for p in re.split(r"[|\n]", raw or "") if p.strip()]

    return {
        "thinking": _split(merged.get("_thinking", "")),
        "contextCompacting": _split(merged.get("_context_compaction", "")),
    }

@router.get("/voice-availability")
async def get_voice_availability(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户实际生效的语音转写模型是否可用，不暴露凭据。"""
    from app.core.config import get_settings
    from app.byok.service import resolve_capability_settings
    from agent.voice import supports_configured_voice_model

    settings = get_settings()
    voice = await resolve_capability_settings(
        db, current_user.id, "speech_to_text", settings.voice,
    )
    return {"available": supports_configured_voice_model(voice)}

@router.get("/commands")
async def get_commands(current_user: User = Depends(get_current_user)):
    """返回聊天输入框使用的规范斜杠命令菜单。"""
    from agent.commands.help import command_menu

    return {"commands": command_menu()}

@router.get("/greeting")
async def get_greeting(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    locale: str = Query(default="zh-CN", pattern="^(zh-CN|ja-JP|en-US)$"),
):
    """对话框默认问候：咕咕据近期记忆/项目/提醒生成一句。"""
    from app.core.config import get_settings
    from app.core.tz import set_ctx_tz, user_tz
    from agent import greeting
    settings = get_settings()
    set_ctx_tz(user_tz(current_user))
    enabled = bool(getattr(settings.agent, "greeting_enabled", True))
    text = await greeting.generate(db, current_user.id, settings, locale=locale)
    return {"text": text if enabled else "", "enabled": enabled}

@router.delete("/memory", status_code=204)
async def clear_memory(
    current_user: User = Depends(get_current_user),
):
    """清除当前用户的全部 AI 记忆——直接删掉 .agent/ 整个目录（含向量缓存等一切衍生文件），
    不再一个个列文件名：新增记忆文件时忘了加进清单会漏删，这个类别的坑一次性堵死。"""
    from agent.memory.store import _DIR
    from app.services.storage import get_storage
    from app.core import events
    storage = get_storage()
    await storage.delete_prefix(f"{current_user.id}/{_DIR}/")
    await events.bump_context_revision(current_user.id, "memory")
