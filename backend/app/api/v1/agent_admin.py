"""
Agent 管理接口（需要 Admin token）
GET  /api/v1/admin/agent/prompts              → 列出所有 profile
GET  /api/v1/admin/agent/prompts/{profile}    → 读取 prompt 内容
PUT  /api/v1/admin/agent/prompts/{profile}    → 写入 prompt 内容

GET    /api/v1/admin/agent/llm-presets           → 列出所有预设（api_key 脱敏）
POST   /api/v1/admin/agent/llm-presets           → 新建预设
PUT    /api/v1/admin/agent/llm-presets/{id}      → 编辑预设（api_key 留空=保持原值）
DELETE /api/v1/admin/agent/llm-presets/{id}      → 删除预设
POST   /api/v1/admin/agent/llm-presets/{id}/activate → 设为当前（同步写入 ai 段）
POST   /api/v1/admin/agent/llm-presets/{id}/test     → 连通性测试
GET    /api/v1/admin/agent/llm-presets/{id}/models   → 获取服务商模型列表（已保存预设）
POST   /api/v1/admin/agent/llm-presets/models-preview → 用临时配置获取模型列表（新建时）

GET    /api/v1/admin/agent/memory/legacy-files          → 扫描已被新文件取代的旧记忆文件（迁移遗留）
POST   /api/v1/admin/agent/memory/legacy-files/cleanup  → 删除指定的旧记忆文件
"""

import asyncio
import hashlib
import json
import time
from app.core.tz import now_utc
import uuid as _uuid
from datetime import datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, select, func, text, literal_column
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import OVERRIDE_FILE, get_settings, write_override_json
from app.db.session import get_db
from app.models import AgentUsage, ConversationSession, ConversationMessage, User

_SPLIT_CACHE_PROVIDERS = ("anthropic", "minimax")


def _effective_input_tokens(provider: str, tokens_in: int, cache_read: int, cache_write: int) -> int:
    """按供应商 usage 约定计算完整输入 token 数。"""
    if (provider or "").lower() in _SPLIT_CACHE_PROVIDERS:
        return tokens_in + cache_read + cache_write
    return tokens_in

# ── 预设辅助函数 ──────────────────────────────────────────────────────────────

def _read_override() -> dict:
    if not OVERRIDE_FILE.exists():
        return {}
    try:
        data = json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("用户运行配置文件损坏，已拒绝覆盖写入") from exc
    if not isinstance(data, dict):
        raise RuntimeError("用户运行配置文件格式无效，已拒绝覆盖写入")
    return data


def _write_override(data: dict):
    write_override_json(data)
    from app.core.config import invalidate_settings_cache
    invalidate_settings_cache()


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return key[:3] + "•" * (len(key) - 7) + key[-4:]


def _effective_input_expr():
    """返回统一口径的完整输入 token 表达式。

    Anthropic 将 cache_read/cache_write 与 input_tokens 分开返回；其他兼容
    OpenAI 的供应商通常已经把缓存 token 包含在 tokens_in 中，不能再次相加。
    """
    return case(
        (
            func.lower(AgentUsage.provider).in_(_SPLIT_CACHE_PROVIDERS),
            AgentUsage.tokens_in + AgentUsage.cache_read + AgentUsage.cache_write,
        ),
        else_=AgentUsage.tokens_in,
    )


def _ensure_presets(override: dict) -> dict:
    """返回 ai_presets dict（若不存在则从 ai 段迁移，但不写文件）。"""
    if "ai_presets" in override:
        return override["ai_presets"]
    ai = override.get("ai", {})
    provider = ai.get("provider", "openai")
    item = {
        "id": "default",
        "name": f"{provider}",
        "provider": provider,
        "api_key": ai.get("api_key", ""),
        "base_url": ai.get("base_url", ""),
        "model": ai.get("model", ""),
        "thinking": ai.get("thinking", "disabled"),
        "ollama_mode": ai.get("ollama_mode", "local"),
    }
    presets = {"active_id": "default", "items": [item]}
    override["ai_presets"] = presets
    return presets

router = APIRouter(prefix="/admin/agent", tags=["admin"])


@router.get("/capabilities")
async def list_capabilities():
    """返回 Admin 用的能力目录，不返回工具 Schema、handler 或 Skill 正文。"""
    from agent.capabilities.index import CapabilityIndex

    snapshot = CapabilityIndex.from_registries().snapshot()
    return {
        "generation": snapshot.generation,
        "diagnostics": list(snapshot.diagnostics),
        "tools": [
            {
                "name": item.name,
                "description_short": item.description_short,
                "category": item.category,
                "permissions": list(item.permissions),
                "platforms": list(item.platforms),
                "related_skills": list(item.related_skills),
                "source": item.source,
                "enabled": item.enabled,
            }
            for item in snapshot.tools.values()
        ],
        "skills": [
            {
                "name": item.name,
                "description_short": item.description_short,
                "category": item.category,
                "related_tools": list(item.related_tools),
                "source": item.source,
                "enabled": item.enabled,
            }
            for item in snapshot.skills.values()
        ],
    }

PROMPTS_DIR = Path(__file__).parent.parent.parent.parent / "agent" / "prompts"

PROFILES = ["default"]   # qq/mini 是早期占位、从未接线（运行时只用 default），已移除以免空 tab 误导

PLACEHOLDERS = [
    {"key": "{today}",       "desc": "今天日期"},
    {"key": "{summary}",     "desc": "当前状态快照（summary.json）"},
    {"key": "{pattern}",     "desc": "咕咕对用户的行为模式（pattern.json 导出）"},
    {"key": "{profile}",     "desc": "咕咕对用户的稳定画像（profile.json 导出）"},
    {"key": "{preferences}", "desc": "咕咕对用户偏好的理解（preferences.md）"},
    {"key": "{memory}",      "desc": "长期认知积累（memory.md）"},
    {"key": "{weekly}",      "desc": "本周记忆摘要"},
    {"key": "{daily}",       "desc": "近期每日记录"},
    {"key": "{projects}",    "desc": "用户当前项目列表"},
    {"key": "{calendar}",    "desc": "近期日历事件"},
    {"key": "{name}",        "desc": "用户昵称（identity.json，通常放 persona.md）"},
]


# 非对话 profile 的特殊可编辑 prompt：persona（人格）、skills（工具使用准则）、
# policy（内容政策）、reflection（反思提炼）、compress（记忆压缩）
SPECIAL_PROMPTS = ["persona", "skills", "policy", "reflection", "compress"]


class ImMemoryMaintenanceRequest(BaseModel):
    confirm: bool = False


_IM_MODEL_PREVIEW_KEY = "im_memory:maintenance:model_preview"
_IM_MODEL_PREVIEW_PLAN_KEY = "im_memory:maintenance:model_preview:plan"


async def _im_model_preview_worker(cursors: list[dict], settings) -> None:
    """逐 scope 调用 IM 反思模型，只保存汇总进度，不保存正文或 scope 标识。"""
    from types import SimpleNamespace

    from agent.context.branch import ContextBranch
    from agent.context.branch_types import BranchInput, BranchPolicy
    from agent.memory.im_reflection import _db_session, _message_text, _messages_for_job, _scope_prompt
    from agent.memory.scoped_store import read_scope
    from agent.memory.scopes import MemoryScope
    from app.core.redis import get_redis

    redis = get_redis()
    done = needs_review = failed = 0
    total = len(cursors)
    plans: list[dict] = []
    for item in cursors:
        try:
            scope = MemoryScope(
                _uuid.UUID(item["owner_user_id"]), item["platform"], item["bot_id"],
                item["scope_type"], item["scope_id"],
            )
            job = SimpleNamespace(
                owner_user_id=scope.owner_user_id, platform=scope.platform,
                bot_id=scope.bot_id, scope_type=scope.scope_type, scope_id=scope.scope_id,
                from_message_id=item["first_message_id"], to_message_id=item["last_message_id"],
            )
            async with await _db_session() as db:
                messages = await _messages_for_job(db, job)
            current = await read_scope(scope)
            payload = "\n".join(
                f"[{m.created_at.isoformat() if m.created_at else '未知时间'}] {_message_text(m)}"
                for m in messages
            )
            prompt_input = (
                f"已有群组/用户记忆：\n{json.dumps(current, ensure_ascii=False)}\n\n"
                f"本批新增消息：\n{payload or '（无新增消息；请仅检查现有记忆是否需要整理）'}"
            )
            branch = await ContextBranch().run(
                BranchInput(
                    stable_system=_scope_prompt(scope),
                    delta=prompt_input,
                    scope=scope.scope_type,
                ),
                BranchPolicy(
                    name="reflection-preview",
                    output_mode="json",
                    max_tokens=2500,
                    thinking="disabled",
                ),
                settings,
            )
            output = branch.output if branch.ok and isinstance(branch.output, dict) else {}
            if output:
                needs_review += 1
                plans.append({
                    "owner_user_id": str(scope.owner_user_id), "platform": scope.platform,
                    "bot_id": scope.bot_id, "scope_type": scope.scope_type, "scope_id": scope.scope_id,
                    "output": output,
                })
        except Exception:
            failed += 1
        done += 1
        await redis.set(_IM_MODEL_PREVIEW_KEY, json.dumps({
            "status": "running", "done": done, "total": total,
            "needs_review": needs_review, "failed": failed,
            "plan_ready": bool(plans), "ts": time.time(),
        }, ensure_ascii=False), ex=3600)
        await redis.set(_IM_MODEL_PREVIEW_PLAN_KEY, json.dumps(plans, ensure_ascii=False), ex=3600)
    # 先写入完整计划，再发布 done 状态，避免前端看到可执行却读不到计划。
    await redis.set(_IM_MODEL_PREVIEW_PLAN_KEY, json.dumps(plans, ensure_ascii=False), ex=3600)
    await redis.set(_IM_MODEL_PREVIEW_KEY, json.dumps({
        "status": "done", "done": done, "total": total,
        "needs_review": needs_review, "failed": failed,
        "plan_ready": bool(plans), "ts": time.time(),
    }, ensure_ascii=False), ex=3600)


def _prompt_path(profile: str) -> Path:
    if profile not in SPECIAL_PROMPTS and profile not in PROFILES:
        raise HTTPException(400, f"未知 profile: {profile}，可选：{SPECIAL_PROMPTS + PROFILES}")
    return PROMPTS_DIR / f"{profile}.md"


@router.get("/prompts")
async def list_prompts():
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    profiles = []
    # persona 最先：咕咕人格，所有 profile 共享，标注谨慎修改
    pp = PROMPTS_DIR / "persona.md"
    profiles.append({
        "profile": "persona",
        "exists": pp.exists(),
        "size": pp.stat().st_size if pp.exists() else 0,
        "is_persona": True,
    })
    # skills：工具使用准则（Execution Policy），紧跟人格注入、所有 profile 共享
    sk = PROMPTS_DIR / "skills.md"
    profiles.append({
        "profile": "skills",
        "exists": sk.exists(),
        "size": sk.stat().st_size if sk.exists() else 0,
        "is_persona": True,
    })
    # policy：内容政策（红线），独立维护、所有 profile 共享
    pol = PROMPTS_DIR / "policy.md"
    profiles.append({
        "profile": "policy",
        "exists": pol.exists(),
        "size": pol.stat().st_size if pol.exists() else 0,
        "is_persona": True,
    })
    # reflection / compress：记忆相关提炼词，非对话 profile，谨慎修改
    for sp in ("reflection", "compress"):
        spp = PROMPTS_DIR / f"{sp}.md"
        profiles.append({
            "profile": sp,
            "exists": spp.exists(),
            "size": spp.stat().st_size if spp.exists() else 0,
            "is_persona": True,
        })
    for name in PROFILES:
        p = PROMPTS_DIR / f"{name}.md"
        profiles.append({
            "profile": name,
            "exists": p.exists(),
            "size": p.stat().st_size if p.exists() else 0,
        })
    return {"profiles": profiles, "placeholders": PLACEHOLDERS}


@router.get("/prompts/{profile}")
async def get_prompt(profile: str):
    p = _prompt_path(profile)
    if not p.exists():
        return {"profile": profile, "content": ""}
    return {"profile": profile, "content": p.read_text(encoding="utf-8")}


class PromptUpdate(BaseModel):
    content: str


@router.put("/prompts/{profile}")
async def update_prompt(profile: str, body: PromptUpdate, request: Request, db: AsyncSession = Depends(get_db)):
    from app.api.v1.audit_log import write_log
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    p = _prompt_path(profile)
    p.write_text(body.content, encoding="utf-8")
    username = getattr(request.state, "admin_username", "admin")
    await write_log(db, username, "prompt", f"更新 Agent 提示词：{profile}", request)
    return {"profile": profile, "saved": True}


@router.get("/usage")
async def get_usage(month: str | None = None, model: str | None = None, db: AsyncSession = Depends(get_db)):
    import calendar as cal

    # 总计
    total_row = await db.execute(
        select(
            func.count(AgentUsage.id),
            func.coalesce(func.sum(_effective_input_expr()), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
            func.coalesce(func.sum(AgentUsage.cache_read), 0),
            func.coalesce(func.sum(AgentUsage.cache_write), 0),
        )
    )
    total_calls, total_in, total_out, total_cache_read, total_cache_write = total_row.one()

    # 今日
    today = now_utc().date()
    today_start = datetime(today.year, today.month, today.day)
    today_row = await db.execute(
        select(
            func.count(AgentUsage.id),
            func.coalesce(func.sum(_effective_input_expr()), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
            func.coalesce(func.sum(AgentUsage.cache_read), 0),
            func.coalesce(func.sum(AgentUsage.cache_write), 0),
        ).where(AgentUsage.created_at >= today_start)
    )
    today_calls, today_in, today_out, today_cache_read, today_cache_write = today_row.one()

    # 按 model 分组
    model_rows = await db.execute(
        select(
            AgentUsage.model,
            AgentUsage.provider,
            func.count(AgentUsage.id),
            func.coalesce(func.sum(_effective_input_expr()), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
            func.coalesce(func.sum(AgentUsage.cache_read), 0),
            func.coalesce(func.sum(AgentUsage.cache_write), 0),
        ).group_by(AgentUsage.model, AgentUsage.provider)
        .order_by(func.count(AgentUsage.id).desc())
    )
    by_model = [
        {"model": r[0], "provider": r[1], "calls": r[2], "tokens_in": r[3], "tokens_out": r[4], "cache_read": r[5], "cache_write": r[6]}
        for r in model_rows.all()
    ]

    # 有数据的月份列表（最近 12 个月）
    months_rows = await db.execute(
        text("""
            SELECT to_char(created_at, 'YYYY-MM') AS m
            FROM agent_usage
            GROUP BY to_char(created_at, 'YYYY-MM')
            ORDER BY m DESC
            LIMIT 12
        """)
    )
    available_months = [r[0] for r in months_rows.all()]

    # 确定目标月份
    if month and month in available_months:
        target_month = month
    elif available_months:
        target_month = available_months[0]
    else:
        target_month = today.strftime("%Y-%m")

    # 目标月份的每日数据（补全所有天）
    try:
        year, mon = int(target_month[:4]), int(target_month[5:7])
    except Exception:
        year, mon = today.year, today.month

    month_start = datetime(year, mon, 1)
    days_in_month = cal.monthrange(year, mon)[1]
    month_end = datetime(year, mon, days_in_month, 23, 59, 59)

    daily_sql = """
            SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                   COUNT(*) AS calls,
                   COALESCE(SUM(CASE WHEN LOWER(provider) IN ('anthropic', 'minimax')
                                     THEN tokens_in + cache_read + cache_write
                                     ELSE tokens_in END), 0) AS tokens_in,
                   COALESCE(SUM(tokens_out), 0) AS tokens_out,
                   COALESCE(SUM(cache_read), 0) AS cache_read,
                   COALESCE(SUM(cache_write), 0) AS cache_write
            FROM agent_usage
            WHERE created_at >= :month_start AND created_at <= :month_end
    """
    daily_params = {"month_start": month_start, "month_end": month_end}
    if model:
        daily_sql += " AND model = :model"
        daily_params["model"] = model
    daily_sql += " GROUP BY to_char(created_at, 'YYYY-MM-DD') ORDER BY day"
    daily_rows = await db.execute(text(daily_sql), daily_params)
    daily_map = {r[0]: {"calls": r[1], "tokens_in": r[2], "tokens_out": r[3], "cache_read": r[4], "cache_write": r[5]}
                 for r in daily_rows.all()}

    from datetime import date
    daily = []
    for d in range(1, days_in_month + 1):
        key = date(year, mon, d).isoformat()
        entry = daily_map.get(key, {"calls": 0, "tokens_in": 0, "tokens_out": 0, "cache_read": 0, "cache_write": 0})
        daily.append({
            "date": key,
            **entry,
            "cache_ratio": round(entry["cache_read"] / entry["tokens_in"], 6)
            if entry["tokens_in"] else 0,
        })

    # 最近 7 天独立于当前月，避免月初/月末查看时被月份边界截断。
    recent_start = datetime(today.year, today.month, today.day) - timedelta(days=6)
    recent_sql = """
            SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                   COUNT(*) AS calls,
                   COALESCE(SUM(CASE WHEN LOWER(provider) IN ('anthropic', 'minimax')
                                     THEN tokens_in + cache_read + cache_write
                                     ELSE tokens_in END), 0) AS tokens_in,
                   COALESCE(SUM(tokens_out), 0) AS tokens_out,
                   COALESCE(SUM(cache_read), 0) AS cache_read,
                   COALESCE(SUM(cache_write), 0) AS cache_write
            FROM agent_usage
            WHERE created_at >= :recent_start AND created_at < :recent_end
    """
    recent_params = {
        "recent_start": recent_start,
        "recent_end": datetime(today.year, today.month, today.day) + timedelta(days=1),
    }
    if model:
        recent_sql += " AND model = :model"
        recent_params["model"] = model
    recent_sql += " GROUP BY to_char(created_at, 'YYYY-MM-DD') ORDER BY day"
    recent_rows = await db.execute(text(recent_sql), recent_params)
    recent_map = {
        r[0]: {
            "calls": r[1], "tokens_in": r[2], "tokens_out": r[3],
            "cache_read": r[4], "cache_write": r[5],
        }
        for r in recent_rows.all()
    }
    recent_daily = []
    for offset in range(7):
        key = (today - timedelta(days=6 - offset)).isoformat()
        entry = recent_map.get(key, {"calls": 0, "tokens_in": 0, "tokens_out": 0, "cache_read": 0, "cache_write": 0})
        recent_daily.append({
            "date": key,
            **entry,
            "cache_ratio": round(entry["cache_read"] / entry["tokens_in"], 6)
            if entry["tokens_in"] else 0,
        })

    return {
        "total":   {"calls": total_calls, "tokens_in": total_in, "tokens_out": total_out, "cache_read": total_cache_read, "cache_write": total_cache_write, "cache_ratio": round(total_cache_read / total_in, 6) if total_in else 0},
        "today":   {"calls": today_calls, "tokens_in": today_in, "tokens_out": today_out, "cache_read": today_cache_read, "cache_write": today_cache_write, "cache_ratio": round(today_cache_read / today_in, 6) if today_in else 0},
        "by_model": by_model,
        "active_model": model,
        "months":   available_months,
        "month":    target_month,
        "daily":    daily,
        "recent_daily": recent_daily,
    }


# ── LLM 预设 CRUD ─────────────────────────────────────────────────────────────

@router.get("/llm-presets")
async def list_llm_presets():
    override = _read_override()
    had_presets = "ai_presets" in override
    presets = _ensure_presets(override)
    if not had_presets:
        _write_override(override)
    from types import SimpleNamespace
    from agent.providers import capability_snapshot
    items = []
    for item in presets.get("items", []):
        ai = SimpleNamespace(**item)
        items.append({
            **item,
            "api_key": _mask_key(item.get("api_key", "")),
            "in_pool": bool(item.get("in_pool", False)),
            "declared_capabilities": capability_snapshot(ai),
        })
    return {"active_id": presets.get("active_id", ""),
            "strategy": presets.get("strategy", "active"),
            "pool_mode": presets.get("pool_mode", "random"), "items": items}


class StrategyUpdate(BaseModel):
    strategy: str | None = None    # active | pool | router
    pool_mode: str | None = None   # random | round_robin | least_loaded


@router.post("/llm-presets/strategy")
async def set_llm_strategy(body: StrategyUpdate):
    if body.strategy is not None and body.strategy not in ("active", "pool", "router"):
        raise HTTPException(400, "strategy 只能是 active / pool / router")
    if body.pool_mode is not None and body.pool_mode not in ("random", "round_robin", "least_loaded"):
        raise HTTPException(400, "pool_mode 只能是 random / round_robin / least_loaded")
    override = _read_override()
    presets = _ensure_presets(override)
    if body.strategy is not None:
        presets["strategy"] = body.strategy
    if body.pool_mode is not None:
        presets["pool_mode"] = body.pool_mode
    _write_override(override)
    return {"strategy": presets.get("strategy", "active"), "pool_mode": presets.get("pool_mode", "random")}


# 同步到 `ai`（当前激活段）的字段 + 默认值——create/update/activate 三处共用，**单一来源**：
# 漏一个字段，active 模型就拿不到 → 表现为「面板保存了却不生效」。新增模型字段时只改这里。
_AI_SYNC_KEYS = ("provider", "api_key", "base_url", "model", "max_tokens", "temperature",
                 "context_tokens", "thinking", "reasoning_effort", "vision", "vision_video",
                 "vision_detail", "vision_audio", "api_format", "ollama_mode", "ollama_api_mode", "ollama_keep_alive",
                 "deployment_mode", "local_runtime", "capability_overrides", "capability_checked_at", "capability_fingerprint")
_AI_DEFAULTS = {"max_tokens": 4000, "temperature": 0.7, "context_tokens": 120000,
                "thinking": "disabled", "reasoning_effort": "", "vision": False,
                "vision_detail": "auto", "vision_video": False, "vision_audio": False, "api_format": "",
                "ollama_mode": "local", "ollama_api_mode": "native", "ollama_keep_alive": "5m",
                "deployment_mode": "cloud", "local_runtime": "other", "capability_overrides": {},
                "capability_checked_at": "", "capability_fingerprint": ""}


def _ai_segment(item: dict) -> dict:
    """从预设 item 抽出要写进 `ai`（激活段）的字段，缺省补默认。"""
    return {k: item.get(k, _AI_DEFAULTS.get(k)) for k in _AI_SYNC_KEYS}


class PresetCreate(BaseModel):
    name: str
    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 4000
    temperature: float = 0.7
    context_tokens: int = 120000
    thinking: str = "disabled"
    reasoning_effort: str = ""
    vision: bool = False
    vision_detail: str = "auto"
    vision_video: bool = False
    vision_audio: bool = False
    api_format: str = ""
    ollama_mode: str = "local"
    ollama_api_mode: str = "native"
    ollama_keep_alive: str = "5m"
    deployment_mode: str = "cloud"
    local_runtime: str = "other"
    capability_overrides: dict[str, bool] = Field(default_factory=dict)
    capability_checked_at: str = ""
    capability_fingerprint: str = ""


@router.post("/llm-presets")
async def create_llm_preset(body: PresetCreate):
    override = _read_override()
    presets = _ensure_presets(override)
    new_id = f"p_{_uuid.uuid4().hex[:8]}"
    item = {
        "id": new_id,
        "name": body.name,
        "provider": body.provider,
        "api_key": body.api_key,
        "base_url": body.base_url,
        "model": body.model,
        "max_tokens": body.max_tokens,
        "temperature": body.temperature,
        "context_tokens": body.context_tokens,
        "thinking": body.thinking,
        "reasoning_effort": body.reasoning_effort,
        "vision": body.vision,
        "vision_detail": body.vision_detail if body.vision_detail in ("auto", "low", "high", "original") else "auto",
        "vision_video": body.vision_video,
        "vision_audio": body.vision_audio,
        "api_format": body.api_format,
        "ollama_mode": body.ollama_mode,
        "ollama_api_mode": body.ollama_api_mode,
        "ollama_keep_alive": body.ollama_keep_alive,
        "deployment_mode": body.deployment_mode,
        "local_runtime": body.local_runtime,
        "capability_overrides": body.capability_overrides,
        "capability_checked_at": body.capability_checked_at,
        "capability_fingerprint": body.capability_fingerprint,
    }
    presets["items"].append(item)
    if not presets.get("active_id"):
        presets["active_id"] = new_id
        override["ai"] = _ai_segment(item)
    _write_override(override)
    return {**item, "api_key": _mask_key(item["api_key"])}


class PresetUpdate(BaseModel):
    name: str | None = None
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    context_tokens: int | None = None
    thinking: str | None = None
    reasoning_effort: str | None = None
    vision: bool | None = None
    vision_detail: str | None = None
    vision_video: bool | None = None
    vision_audio: bool | None = None
    api_format: str | None = None
    ollama_mode: str | None = None
    ollama_api_mode: str | None = None
    ollama_keep_alive: str | None = None
    deployment_mode: str | None = None
    local_runtime: str | None = None
    capability_overrides: dict[str, bool] | None = None
    in_pool: bool | None = None


@router.put("/llm-presets/{preset_id}")
async def update_llm_preset(preset_id: str, body: PresetUpdate):
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    if body.name is not None:
        item["name"] = body.name
    if body.provider is not None:
        item["provider"] = body.provider
    if body.api_key:
        item["api_key"] = body.api_key
    if body.base_url is not None:
        item["base_url"] = body.base_url
    if body.model is not None:
        item["model"] = body.model
    if body.max_tokens is not None:
        item["max_tokens"] = body.max_tokens
    if body.temperature is not None:
        item["temperature"] = body.temperature
    if body.context_tokens is not None:
        item["context_tokens"] = body.context_tokens
    if body.thinking is not None:
        item["thinking"] = body.thinking
    if body.reasoning_effort is not None:
        item["reasoning_effort"] = body.reasoning_effort
    if body.vision is not None:
        item["vision"] = body.vision
    if body.vision_detail is not None:
        item["vision_detail"] = body.vision_detail if body.vision_detail in ("auto", "low", "high", "original") else "auto"
    if body.vision_video is not None:
        item["vision_video"] = body.vision_video
    if body.vision_audio is not None:
        item["vision_audio"] = body.vision_audio
    if body.api_format is not None:
        item["api_format"] = body.api_format
    if body.ollama_mode is not None:
        item["ollama_mode"] = body.ollama_mode
    if body.ollama_api_mode is not None:
        item["ollama_api_mode"] = body.ollama_api_mode
    if body.ollama_keep_alive is not None:
        item["ollama_keep_alive"] = body.ollama_keep_alive
    if body.deployment_mode is not None:
        item["deployment_mode"] = body.deployment_mode
    if body.local_runtime is not None:
        item["local_runtime"] = body.local_runtime
    if body.capability_overrides is not None:
        item["capability_overrides"] = body.capability_overrides
        item["capability_checked_at"] = ""
        item["capability_fingerprint"] = ""
    if body.in_pool is not None:
        item["in_pool"] = body.in_pool
    if presets.get("active_id") == preset_id:
        override["ai"] = _ai_segment(item)
    _write_override(override)
    return {**item, "api_key": _mask_key(item["api_key"])}


@router.delete("/llm-presets/{preset_id}")
async def delete_llm_preset(preset_id: str):
    override = _read_override()
    presets = _ensure_presets(override)
    if len(presets.get("items", [])) <= 1:
        raise HTTPException(400, "至少保留一个预设")
    if presets.get("active_id") == preset_id:
        raise HTTPException(400, "无法删除当前激活的预设，请先切换到其他预设")
    presets["items"] = [it for it in presets["items"] if it["id"] != preset_id]
    _write_override(override)
    return {"deleted": preset_id}


@router.post("/llm-presets/{preset_id}/activate")
async def activate_llm_preset(preset_id: str):
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    presets["active_id"] = preset_id
    override["ai"] = _ai_segment(item)
    _write_override(override)
    return {"active_id": preset_id}


@router.post("/llm-presets/{preset_id}/test")
async def test_llm_preset(preset_id: str):
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    provider = item.get("provider", "openai")
    api_key  = item.get("api_key", "")
    base_url = item.get("base_url", "").rstrip("/")
    model    = item.get("model", "")
    from app.services.provider_diagnostics import test_provider_credential
    result = await test_provider_credential(provider=provider, api_key=api_key, base_url=base_url,
                                            model=model, api_format=item.get("api_format", ""))
    return {**result, "probe": {"status": result["status"]}}


def _capability_fingerprint(item: dict) -> str:
    value = "|".join(str(item.get(key, "")) for key in ("provider", "local_runtime", "base_url", "model"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


async def _probe_local_capabilities(item: dict) -> dict:
    """用无副作用短请求检测本地 OpenAI 兼容服务的基础能力。"""
    import httpx
    from types import SimpleNamespace
    from agent import providers

    ai = SimpleNamespace(**item)
    adapter = providers.adapter_for(ai)
    base_url = adapter.resolve_base_url(ai).rstrip("/")
    api_key = item.get("api_key") or "local"
    headers = {"Authorization": f"Bearer {api_key}", "content-type": "application/json"}
    result = {name: {"status": "未检测", "detail": ""} for name in
              ("chat", "stream", "tools", "json_object", "json_schema", "reasoning")}
    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=8, read=30, write=8, pool=5),
                                 follow_redirects=False) as client:
        try:
            response = await client.get(f"{base_url}/models", headers=headers)
            result["chat"] = {"status": "支持" if response.status_code < 400 else "检测失败",
                              "detail": f"HTTP {response.status_code}"}
        except Exception as exc:
            result["chat"] = {"status": "检测失败", "detail": type(exc).__name__}
            return result
        payload = {"model": item.get("model", ""), "messages": [{"role": "user", "content": "回复 OK"}],
                   "max_tokens": 4, "temperature": 0, "stream": False}
        try:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
            result["chat"] = {"status": "支持" if response.status_code < 400 else "检测失败",
                              "detail": f"HTTP {response.status_code}"}
        except Exception as exc:
            result["chat"] = {"status": "检测失败", "detail": type(exc).__name__}
        try:
            stream_payload = {**payload, "stream": True}
            async with client.stream("POST", f"{base_url}/chat/completions", headers=headers,
                                     json=stream_payload) as response:
                result["stream"] = {"status": "支持" if response.status_code < 400 else "检测失败",
                                    "detail": f"HTTP {response.status_code}"}
                if response.status_code < 400:
                    async for _ in response.aiter_lines():
                        break
        except Exception as exc:
            result["stream"] = {"status": "检测失败", "detail": type(exc).__name__}
        tool_payload = {**payload, "tools": [{"type": "function", "function": {
            "name": "probe_noop", "description": "无副作用测试工具", "parameters": {"type": "object"}}}],
            "tool_choice": "auto"}
        try:
            response = await client.post(f"{base_url}/chat/completions", headers=headers, json=tool_payload)
            result["tools"] = {"status": "支持" if response.status_code < 400 else "需服务端配置",
                                "detail": f"HTTP {response.status_code}"}
        except Exception as exc:
            result["tools"] = {"status": "需服务端配置", "detail": type(exc).__name__}
        for kind, fmt in (("json_object", {"type": "json_object"}),
                          ("json_schema", {"type": "json_schema", "json_schema": {
                              "name": "probe", "schema": {"type": "object"}}})):
            try:
                response = await client.post(f"{base_url}/chat/completions", headers=headers,
                                             json={**payload, "response_format": fmt})
                result[kind] = {"status": "支持" if response.status_code < 400 else "需服务端配置",
                                "detail": f"HTTP {response.status_code}"}
            except Exception as exc:
                result[kind] = {"status": "需服务端配置", "detail": type(exc).__name__}
    result["reasoning"] = {"status": "未检测", "detail": "推理字段依赖模型与服务端配置，请人工确认"}
    return result


@router.post("/llm-presets/{preset_id}/capabilities")
async def probe_llm_capabilities(preset_id: str):
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    if item.get("provider") == "ollama" and item.get("ollama_api_mode", "native") == "native":
        raise HTTPException(400, "Ollama 原生模式请使用连通性/多模态检测；能力探测接口仅支持 OpenAI 兼容模式")
    result = await _probe_local_capabilities(item)
    fingerprint = _capability_fingerprint(item)
    checked_at = now_utc().isoformat()
    item["capability_checked_at"] = checked_at
    item["capability_fingerprint"] = fingerprint
    item["capability_probe"] = result
    if presets.get("active_id") == preset_id:
        override["ai"] = _ai_segment(item)
    _write_override(override)
    from types import SimpleNamespace
    from agent import providers
    return {"fingerprint": fingerprint, "checked_at": checked_at, "results": result,
            "declared_capabilities": providers.capability_snapshot(SimpleNamespace(**item))}


@router.put("/llm-presets/{preset_id}/capability-overrides")
async def update_capability_overrides(preset_id: str, body: dict[str, bool]):
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    allowed = {"thinking", "structured_json", "structured_schema", "tools", "parallel_tools", "vision", "audio", "video"}
    if any(key not in allowed or not isinstance(value, bool) for key, value in body.items()):
        raise HTTPException(400, "能力覆盖字段或值无效")
    item["capability_overrides"] = body
    item["capability_checked_at"] = ""
    item["capability_fingerprint"] = ""
    if presets.get("active_id") == preset_id:
        override["ai"] = _ai_segment(item)
    _write_override(override)
    return {"capability_overrides": body}


async def _fetch_provider_models(base_url: str, provider: str, api_key: str, api_format: str = "") -> list[str]:
    """向服务商请求模型列表，返回去重排序后的模型 id 列表。

    - Anthropic 兼容端点的模型列表路径是 /v1/models；base_url 可能已含 /v1
      （如 https://api.anthropic.com/v1），也可能不含（如 MiniMax 的
      https://api.minimaxi.com/anthropic），统一补成 /v1/models，避免 404。
    - API Key 只在后端使用，不落日志、不进响应。
    """
    import httpx
    from app.core.redaction import diag_log
    from types import SimpleNamespace

    base_url = (base_url or "").rstrip("/")
    _ns = SimpleNamespace(provider=provider, base_url=base_url, api_format=api_format, api_key=api_key)
    from agent import providers
    adapter = providers.adapter_for(_ns)
    base_url = adapter.resolve_base_url(_ns)
    if not base_url:
        raise HTTPException(400, "请先填写 Base URL")
    request = adapter.models_request(_ns)
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=False) as client:
            response = await client.get(f"{base_url}{request['path']}", headers=request["headers"])
        if response.status_code >= 400:
            diag_log("admin.llm_preset_models.upstream", RuntimeError(
                f"status={response.status_code} body={response.text[:500]}"))
            if response.status_code in (401, 403):
                raise HTTPException(502, "服务商鉴权失败")
            raise HTTPException(502, f"服务商暂不支持模型列表（HTTP {response.status_code}）")
        payload = response.json()
        rows = payload.get("data", []) if isinstance(payload, dict) else payload
        return sorted({str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")})
    except HTTPException:
        raise
    except Exception as exc:
        diag_log("admin.llm_preset_models", exc)
        raise HTTPException(502, "获取模型列表失败，请检查地址和网络") from exc


@router.get("/llm-presets/{preset_id}/models")
async def list_llm_preset_models(preset_id: str):
    """从已保存预设的服务商读取模型列表；API Key 只在后端使用。"""
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    models = await _fetch_provider_models(
        str(item.get("base_url") or ""),
        str(item.get("provider") or "openai"),
        str(item.get("api_key") or ""),
        str(item.get("api_format") or ""),
    )
    return {"models": models, "source": "provider"}


class ModelsPreview(BaseModel):
    provider: str = "openai"
    base_url: str = ""
    api_key: str = ""
    api_format: str = ""
    local_runtime: str = "other"


@router.post("/llm-presets/models-preview")
async def preview_llm_preset_models(body: ModelsPreview):
    """用表单里的临时配置获取模型列表（新建预设时用，无需先保存）。"""
    models = await _fetch_provider_models(body.base_url, body.provider, body.api_key, body.api_format)
    return {"models": models, "source": "provider"}


def _probe_png_b64() -> str:
    """纯 stdlib 造一张 64×64 实色 PNG 的 base64，用作多模态探测图（不依赖 Pillow）。

    尺寸选择：百炼 qwen 等 OpenAI 兼容厂商对图片有最小尺寸限制（如百炼要求宽/高 >10px），
    8×8 会被误判成"模型不支持多模态"。64×64 同时满足各家常见下限，又不增加带宽负担。"""
    import base64
    import struct
    import zlib
    w = h = 64
    row = b"\x00" + b"\xe0\x40\x40" * w          # 每行：filter 0 + 64 像素(RGB 暗红)
    idat = zlib.compress(row * h)
    def _chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))   # 8bit, RGB
           + _chunk(b"IDAT", idat)
           + _chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


def _probe_wav_b64() -> str:
    """纯 stdlib 造一段 0.1s 静音 16bit/8kHz 单声道 WAV 的 base64，用作音频探测（不依赖 ffmpeg）。

    只含 WAV 头 + 静音 PCM，体积极小；用于探测主模型是否接受 input_audio 音频块。"""
    import base64
    import struct
    import wave
    import io
    rate = 8000
    frames = rate // 10                       # 0.1s
    pcm = b"\x00\x00" * frames                # 静音
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode()


_PROBE_MP4_B64_CACHE: str | None = None


def _probe_mp4_b64() -> str:
    """用 ffmpeg 生成一段 3 秒 320×240 的动态测试视频（testsrc 彩条）并返回 base64，
    用作视频探测的真实样本（不依赖 PIL/Pillow）。

    缓存到模块级：同一进程内只生成一次。ffmpeg 不可用时抛 RuntimeError，由探测函数降级。
    百炼/千问等视频理解模型对「图像列表」形式（4 张 PNG）会返回极慢（80s+）且识别不出内容，
    必须发真实 mp4 才能正确探测视频能力。"""
    global _PROBE_MP4_B64_CACHE
    if _PROBE_MP4_B64_CACHE is not None:
        return _PROBE_MP4_B64_CACHE
    import base64
    import os
    import shutil
    import subprocess
    import tempfile
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg 未安装，无法生成视频探测样本")
    # 3s / 320x240 / 10fps / libx264 / yuv420p / +faststart，约 16KB。
    # 百炼/千问要求视频 ≥2s，1s 会被拒（"The video file is too short"）；3s 更稳妥。
    # mp4 muxer 不支持非 seekable 输出，必须写临时文件再读回。
    fd, tmp = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        cmd = [ffmpeg, "-y", "-loglevel", "error",
               "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
               "-c:v", "libx264", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", tmp]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg 生成探测视频失败：{proc.stderr.decode(errors='ignore')[:200]}")
        with open(tmp, "rb") as f:
            data = f.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    if not data:
        raise RuntimeError("ffmpeg 生成的探测视频为空")
    _PROBE_MP4_B64_CACHE = base64.b64encode(data).decode()
    return _PROBE_MP4_B64_CACHE


async def _do_vision_probe(provider, api_key, base_url, model, api_format="", dim="image") -> tuple:
    """发一个极小媒体给模型，看接不接受。用真正的 SDK 客户端（与 runner 同款），
    路径/鉴权头由 SDK 拼，避免手写 URL 在 minimax 这种 base_url 上猜错。

    `dim`：image | video | audio，决定探测哪种媒体块。
    返回 (supported, status, detail)：True=支持 / False=纯文本 / None=测不准。"""
    import httpx
    import inspect
    from types import SimpleNamespace
    from agent import providers
    dim_label = {"image": "图片", "video": "视频", "audio": "音频"}.get(dim, dim)
    # 适配器解析和客户端构造也放进统一诊断边界。此前这里任一配置/依赖异常
    # 会在 BYOK 路由被统一改写成 502「检测失败」，用户看不到可行动原因。
    client = None

    async def close_probe_client() -> None:
        close = getattr(client, "close", None)
        if close is not None:
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                pass

    try:
        _ns = SimpleNamespace(provider=provider, base_url=base_url, api_key=api_key,
                              model=model, api_format=api_format)
        adapter = providers.adapter_for(_ns)
        is_anthropic = adapter.protocol_format(_ns) == "anthropic"
        # 视频理解耗时明显更长，单独放宽 read 超时，避免前端误判为失败。
        read_timeout = 90.0 if dim == "video" else 25.0
        timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=5.0)
    except Exception as exc:
        from app.core.redaction import diag_log
        diag_log("admin.vision_probe.setup", exc)
        return None, 0, f"检测初始化失败（{type(exc).__name__}），请检查 Provider、协议和 Base URL"

    # 视频在 Anthropic 路（MiniMax M3）是硬编码已知能力，无需探测；其余 Anthropic 路不支持视频块
    if dim == "video" and is_anthropic:
        if adapter.supports_video(model):
            return True, 200, "MiniMax M3 原生支持视频块 ✅"
        return False, 200, "Anthropic 路当前仅 MiniMax M3 支持视频块"

    # MiMo 的 OpenAI 扩展块（video_url / input_audio）是已知能力，直接判定，避免探测格式不匹配误判
    if not is_anthropic and dim in ("video", "audio"):
        if (dim == "video" and adapter.supports_video(model)) or (dim == "audio" and adapter.supports_audio(model)):
            return True, 200, f"MiMo 原生支持{dim_label}输入 ✅"

    try:
        if is_anthropic:
            client = providers.build_anthropic_client(_ns, timeout)
            if dim == "image":
                content = [
                    {"type": "text", "text": "这张图是什么颜色？用一个词回答。"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                 "data": _probe_png_b64()}},
                ]
            elif dim == "audio":
                content = [
                    {"type": "text", "text": "这段音频说了什么？用一个词回答。"},
                    {"type": "input_audio", "source": {"type": "base64", "media_type": "audio/wav",
                                                       "data": _probe_wav_b64()}},
                ]
            else:  # video（Anthropic 路已在上方拦截，这里兜底）
                return False, 200, "Anthropic 路不支持视频探测"
            await client.messages.create(model=model, max_tokens=16,
                                         messages=[{"role": "user", "content": content}])
        else:
            client = providers.build_openai_client(_ns, timeout)
            if dim == "image":
                content = [
                    {"type": "text", "text": "这张图是什么颜色？用一个词回答。"},
                    {"type": "image_url", "image_url": {
                        "url": f"data:image/png;base64,{_probe_png_b64()}", "detail": "auto"}},
                ]
            elif dim == "video":
                # 用真实 mp4（video_url 块）探测视频理解。百炼/千问等对「图像列表」形式
                # （type=video + 4 张 PNG）会返回极慢（80s+）且识别不出内容，必须发真实视频。
                # ffmpeg 不可用时降级为纯文本判定（返回 None，提示无法生成样本）。
                # 首次生成会同步跑 ffmpeg（最长 30s），丢线程池避免阻塞事件循环。
                try:
                    mp4_b64 = await asyncio.to_thread(_probe_mp4_b64)
                except RuntimeError as e:
                    return None, 200, f"无法生成视频探测样本：{e}"
                content = [
                    {"type": "text", "text": "这段视频里发生了什么？用一个词回答。"},
                    {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{mp4_b64}"},
                     "fps": 2},
                ]
            else:  # audio
                content = [
                    {"type": "text", "text": "这段音频说了什么？用一个词回答。"},
                    {"type": "input_audio", "input_audio": {
                        "data": f"data:audio/wav;base64,{_probe_wav_b64()}"}},
                ]
            await client.chat.completions.create(model=model, max_tokens=16,
                                                 messages=[{"role": "user", "content": content}])
        await close_probe_client()
        return True, 200, f"模型接受了{dim_label}输入 ✅"
    except Exception as e:
        await close_probe_client()
        sc = getattr(e, "status_code", None) or 0
        msg = str(e)[:200]
        if sc in (400, 422):
            # 400/422 不一定是「不支持媒体」——也可能来自块格式差异、参数名不兼容、视频长度/格式
            # 问题、模型服务临时校验错误。只有错误文本明确表达「不支持这种媒体」才判定为纯文本模型；
            # 无法确定时返回 None（测不准），**不写回配置**，避免把本来支持视频的模型误标成不支持。
            low = msg.lower()
            unsupported_hints = (
                "not support", "unsupported", "does not support", "don't support",
                "invalid image", "invalid video", "invalid audio",
                "image not", "video not", "audio not",
                "media type", "content type", "unrecognized", "unknown field",
                "image_url", "video_url", "input_audio", "image_urls",
            )
            if any(h in low for h in unsupported_hints):
                return False, sc, f"模型拒绝了{dim_label}输入，应为纯文本模型：{msg}"
            return None, sc, f"未能判定（{sc}）：{msg}"
        if sc in (401, 403):
            return None, sc, f"鉴权失败（{sc}），先确认 Key/连通性再测"
        if sc == 404:
            return None, sc, f"模型名或地址不对（{sc}）：{msg}"
        return None, sc, f"未能判定：{msg}"


class VisionProbePreview(BaseModel):
    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    api_format: str = ""


async def _run_vision_probe(item: dict, dims: list[str]) -> dict:
    results = {}
    for d in dims:
        supported, sc, detail = await _do_vision_probe(
            item.get("provider", "openai"), item.get("api_key", ""),
            item.get("base_url", "").rstrip("/"), item.get("model", ""),
            item.get("api_format", ""), dim=d)
        results[d] = {"supported": supported, "status": sc, "detail": detail}
    return results


def _apply_vision_probe(item: dict, results: dict) -> None:
    """只把明确的 True/False 写回能力字段，测不准时保留原值。"""
    for dim, result in results.items():
        supported = result.get("supported")
        if supported is None:
            continue
        field = "vision" if dim == "image" else f"vision_{dim}"
        item[field] = bool(supported)


@router.post("/llm-presets/probe-vision-preview")
async def probe_vision_preview(body: VisionProbePreview, dim: str = "image"):
    """检测尚未保存的预设草稿，不写入服务端配置。"""
    if dim not in ("image", "video", "audio"):
        raise HTTPException(400, "dim 仅支持 image/video/audio")
    results = await _run_vision_probe(body.model_dump(), [dim])
    return {"dim": dim, **results[dim]}


@router.post("/llm-presets/{preset_id}/probe-vision")
async def probe_vision_preset(preset_id: str, dim: str = ""):
    """探测预设模型的多模态能力，并把明确结论写回对应字段。

    `dim`：image | video | audio，只测单维度；省略则依次测全部三维度。
    返回：单维度 → {supported,status,detail,dim}；全维度 → {results:{image:{...},video:{...},audio:{...}}}。"""
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    dims = [dim] if dim else ["image", "video", "audio"]
    if any(d not in ("image", "video", "audio") for d in dims):
        raise HTTPException(400, "dim 仅支持 image/video/audio")

    from types import SimpleNamespace
    from agent.providers import capability_snapshot
    declared_capabilities = capability_snapshot(SimpleNamespace(**item))

    results = await _run_vision_probe(item, dims)
    _apply_vision_probe(item, results)
    if presets.get("active_id") == preset_id:
        override["ai"] = _ai_segment(item)
    _write_override(override)
    if len(dims) == 1:
        d = dims[0]
        result = results[d]
        return {**result, "dim": d, "declared_capabilities": declared_capabilities,
                "probe": {"supported": result["supported"], "status": result["status"]}}
    return {"results": results, "declared_capabilities": declared_capabilities,
            "probe": results}


# IM 机器人接入：飞书 / QQ 都走「用户自带(BYO)」，在用户设置里管理
# （/me/bots、/me/feishu/connect、/me/qq/connect），不再有 Admin 共享频道 CRUD。


# ── 决策轨迹（只读调试）──────────────────────────────────────────────────────
# 复用现有数据，无需额外埋点：工具调用/结果在 ConversationMessage.content_json（即
# getMessages 用 content_json IS NULL 过滤掉的 tool_use / tool_result 行），每次 LLM
# 调用的 token/模型在 AgentUsage。供 Admin「决策轨迹」tab 排查咕咕每轮怎么决策的。
#
# 隐私（脱敏保留）：决策轨迹只暴露「决策结构」，不暴露用户内容——对话正文 / 工具结果 /
# 文件名 / 会话标题一律脱敏，工具入参只保留 id/数字/布尔等结构字段、字符串值打码。管理员能
# 排查咕咕「调了什么、落到哪、成没成」，但看不到用户聊了什么。脱敏在后端做（数据不出后端）。

_REDACT_STR = "***"


def _redact_text(s: str | None) -> str:
    """正文脱敏：不返回原文，只给字数提示（保留『这里有内容』的可观测性，不泄露内容）。"""
    return f"〔已隐藏 · {len(s)} 字〕" if s else ""


def _redact_args(v):
    """工具入参脱敏：dict/list 结构与 数字/布尔/null 原样保留（project_id 等便于排查落位），字符串一律打码。"""
    if isinstance(v, dict):
        return {k: _redact_args(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_redact_args(x) for x in v]
    if isinstance(v, str):
        return _REDACT_STR
    return v


def _redact_cj(blocks):
    """content_json 块脱敏：保留文本和工具结构，正文与工具结果内容打码。"""
    if not blocks:
        return blocks
    out = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": _redact_text(b.get("text", ""))})
        elif t in ("tool_use", "tool_call"):
            arguments = b.get("input", b.get("arguments", {}))
            wire_type = "tool_use" if t == "tool_use" else "tool_call"
            argument_key = "input" if t == "tool_use" else "arguments"
            out.append({"type": wire_type, "name": b.get("name"), argument_key: _redact_args(arguments)})
        elif t == "tool_result":
            out.append({"type": t, "is_error": bool(b.get("is_error")), "content": "〔结果已隐藏〕"})
    return out


@router.get("/sessions")
async def list_agent_sessions(
    user: str | None = None,
    q: str | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """会话列表（最近更新优先），供决策轨迹查看器选择。"""
    stmt = (
        select(ConversationSession, User.username, User.display_name)
        .outerjoin(User, User.id == ConversationSession.user_id)
        .order_by(ConversationSession.updated_at.desc())
        .limit(min(limit, 200))
    )
    # 标题来自用户首句、属隐私，不再按标题内容检索（否则可凭关键词试探用户聊了什么）；只按用户名筛选
    if user:
        stmt = stmt.where(User.username.ilike(f"%{user}%"))
    rows = (await db.execute(stmt)).all()
    sids = [s.id for s, _, _ in rows]
    counts: dict[int, int] = {}
    if sids:
        cres = await db.execute(
            select(ConversationMessage.session_id, func.count())
            .where(ConversationMessage.session_id.in_(sids))
            .group_by(ConversationMessage.session_id)
        )
        counts = {sid: n for sid, n in cres.all()}
    return [
        {
            "id": s.id, "title": f"会话 #{s.id}", "source": s.source,   # 标题脱敏：不暴露用户首句
            "user": dn or un or "—",
            "updatedAt": s.updated_at.isoformat(),
            "createdAt": s.created_at.isoformat(),
            "msgCount": counts.get(s.id, 0),
        }
        for s, un, dn in rows
    ]


@router.get("/sessions/{session_id}/trace")
async def session_trace(session_id: int, db: AsyncSession = Depends(get_db)):
    """单会话完整决策轨迹：含被 getMessages 过滤掉的 tool_use/tool_result 行 + 每次调用 token。
    后端只透传原始数据（含 content_json 块），由前端解析渲染时间线。"""
    session = await db.get(ConversationSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    owner = await db.get(User, session.user_id)
    msgs = (await db.execute(
        select(ConversationMessage)
        .where(ConversationMessage.session_id == session_id)
        .order_by(ConversationMessage.created_at, ConversationMessage.id)
    )).scalars().all()
    usage = (await db.execute(
        select(AgentUsage)
        .where(AgentUsage.session_id == session_id)
        .order_by(AgentUsage.created_at, AgentUsage.id)
    )).scalars().all()
    return {
        "session": {
            "id": session.id, "title": f"会话 #{session.id}", "source": session.source,   # 标题脱敏
            "user": (owner.display_name or owner.username) if owner else "—",
            "createdAt": session.created_at.isoformat(),
            "updatedAt": session.updated_at.isoformat(),
        },
        "messages": [
            {
                "role": m.role,
                "content": _redact_text(m.content),          # 正文脱敏（只给字数）
                "contentJson": _redact_cj(m.content_json),   # 块脱敏：留工具名/结构，正文与结果打码
                "files": [{"name": _REDACT_STR, "ext": (f or {}).get("ext", "")} for f in (m.files or [])] or None,
                "createdAt": m.created_at.isoformat(),
            }
            for m in msgs
        ],
        "usage": [
            {
                "tokensIn": u.tokens_in, "tokensOut": u.tokens_out,
                "model": u.model, "provider": u.provider,
                "toolsUsed": u.tools_used,
                "createdAt": u.created_at.isoformat(),
            }
            for u in usage
        ],
    }


# ── 状态命名：对话里「状态指示」的显示名（工具名 + 特殊状态），后台可改、热生效 ──────────────

class StateLabelsUpdate(BaseModel):
    overrides: dict[str, str] = {}


@router.get("/state-labels")
async def get_state_labels():
    """列出所有可命名状态：special（思考中三点/整理中/复查前缀）+ tools（每个工具）。
    default=代码默认，custom=后台覆盖值，label=实际显示（custom or default）。"""
    from agent.tools import registry
    from agent.core import SPECIAL_STATE_LABELS
    ov = (_read_override().get("state_labels") or {}).get("overrides") or {}

    def _row(key, default):
        custom = ov.get(key, "")
        return {"key": key, "default": default, "custom": custom, "label": custom or default}

    special = [_row(k, v) for k, v in SPECIAL_STATE_LABELS.items()]
    tools = [_row(k, v) for k, v in sorted(registry.labels().items())]
    return {"special": special, "tools": tools}


@router.put("/state-labels")
async def update_state_labels(body: StateLabelsUpdate):
    """保存覆盖：空值 / 等于默认值的不落库（保持 override 干净，未设的自动回退默认）。"""
    from agent.tools import registry
    from agent.core import SPECIAL_STATE_LABELS
    defaults = {**SPECIAL_STATE_LABELS, **registry.labels()}
    clean: dict[str, str] = {}
    for k, v in (body.overrides or {}).items():
        v = (v or "").strip()
        if not v or (k in defaults and v == defaults[k]):
            continue
        clean[k] = v
    override = _read_override()
    override["state_labels"] = {"overrides": clean}
    _write_override(override)
    return {"ok": True, "count": len(clean)}


# ── 记忆旧文件清理：迁移类改动（facts.md/facts.json→pattern.json、summary.md+summary.ts→
# summary.json）为了不影响读旧数据的用户，旧文件从不自动删，长期堆在存储里。这里给个 admin
# 入口手动扫描+清（跟 StorageAudit 的孤儿文件对账同一套「先扫、勾选、再删」交互）。────────

# 旧文件名 → 取代它的新文件名；只有新文件已存在（=已经迁移过、旧文件确认不再被读）才判定可删，
# 防止误删还没被迁移读过一次的原始数据。
_LEGACY_MEMORY_FILES = {
    "summary.md": "summary.json",
    "summary.ts": "summary.json",
    "facts.md": "pattern.json",
    "facts.json": "pattern.json",
}


@router.get("/memory/legacy-files")
async def scan_legacy_memory_files():
    """扫描所有用户的 .agent/ 目录，列出已被新文件取代、可安全清理的旧记忆文件。"""
    from app.services.storage import get_storage
    storage = get_storage()
    all_keys = await storage.list_keys()
    found = []
    for key in all_keys:
        parts = key.split("/")
        if len(parts) < 3 or parts[-2] != ".agent":
            continue
        name = parts[-1]
        new_name = _LEGACY_MEMORY_FILES.get(name)
        if not new_name:
            continue
        new_key = "/".join(parts[:-1] + [new_name])
        safe = await storage.exists(new_key)
        info = await storage.stat(key)
        found.append({
            "key": key, "legacyFile": name, "replacedBy": new_name,
            "safeToDelete": safe, "size": info.size if info else None,
        })
    found.sort(key=lambda x: (not x["safeToDelete"], x["key"]))
    return {"files": found, "safeCount": sum(1 for f in found if f["safeToDelete"])}


class LegacyFilesCleanup(BaseModel):
    keys: list[str]


@router.post("/memory/legacy-files/cleanup")
async def cleanup_legacy_memory_files(body: LegacyFilesCleanup):
    """删除指定的旧记忆文件 key。逐个重新核实「新文件已存在」才删——防止扫描和点击清理之间
    数据发生变化（比如恰好这时候又读到旧文件触发了一次新的迁移写入）导致误删。"""
    from app.services.storage import get_storage
    storage = get_storage()
    deleted, skipped = [], []
    for key in body.keys or []:
        parts = key.split("/")
        if len(parts) < 3 or parts[-2] != ".agent":
            skipped.append(key)
            continue
        new_name = _LEGACY_MEMORY_FILES.get(parts[-1])
        new_key = "/".join(parts[:-1] + [new_name]) if new_name else None
        if not new_key or not await storage.exists(new_key):
            skipped.append(key)
            continue
        await storage.delete(key)
        deleted.append(key)
    return {"deleted": deleted, "skipped": skipped}


@router.get("/memory/im-scopes")
async def list_im_memory_scopes():
    """返回 IM 记忆汇总统计；不返回 owner、群组或成员标识。"""
    from agent.memory.scope_lifecycle import list_scopes

    scopes = await list_scopes(limit=10000)
    by_platform: dict[str, dict[str, int]] = {}
    total_entries = pending_jobs = failed_jobs = needs_maintenance = 0
    for scope in scopes:
        platform = str(scope.get("platform") or "unknown")
        stats = by_platform.setdefault(platform, {"scopes": 0, "groups": 0, "members": 0, "entries": 0})
        stats["scopes"] += 1
        stats["groups"] += int(scope.get("scope_type") == "group")
        stats["members"] += int(scope.get("scope_type") == "platform-user")
        stats["entries"] += int(scope.get("entry_count") or 0)
        total_entries += int(scope.get("entry_count") or 0)
        pending_jobs += int(scope.get("pending_jobs") or 0)
        failed_jobs += int(scope.get("failed_jobs") or 0)
        last_message_id = scope.get("last_message_id")
        last_reflected_id = scope.get("last_reflected_message_id") or 0
        if last_message_id is not None and int(last_message_id) > int(last_reflected_id):
            needs_maintenance += 1
    return {
        "total_scopes": len(scopes),
        "groups": sum(1 for scope in scopes if scope.get("scope_type") == "group"),
        "members": sum(1 for scope in scopes if scope.get("scope_type") == "platform-user"),
        "total_entries": total_entries,
        "pending_jobs": pending_jobs,
        "needs_maintenance": needs_maintenance,
        "failed_jobs": failed_jobs,
        "platforms": [{"platform": platform, **stats} for platform, stats in sorted(by_platform.items())],
    }


@router.post("/memory/im-scopes/maintenance/preview")
async def preview_im_memory_maintenance():
    """生成不含任何 scope 标识的 IM 记忆维护预览。"""
    return await list_im_memory_scopes()


@router.post("/memory/im-scopes/maintenance/model-preview")
async def start_im_memory_model_preview(db: AsyncSession = Depends(get_db)):
    """异步调用 IM 维护模型；只保存进度和数量，不保存模型正文。"""
    from app.core.redis import get_redis
    from app.models import MemoryReflectionCursor

    redis = get_redis()
    raw = await redis.get(_IM_MODEL_PREVIEW_KEY)
    if raw:
        current = json.loads(raw if isinstance(raw, str) else raw.decode())
        if current.get("status") == "running":
            return {"ok": False, "message": "已有模型预览正在运行", "status": current}
    # 仅在确认没有并发预览后清理旧计划，避免重复点击时删掉正在生成的计划。
    await redis.delete(_IM_MODEL_PREVIEW_PLAN_KEY)
    rows = (await db.execute(select(MemoryReflectionCursor))).scalars().all()
    cursors = []
    for row in rows:
        # 模型预览检查已有 scope 的当前记忆；没有新增消息时也要让模型判断
        # 当前内容是否需要提炼，不能因为没有游标缺口就直接跳过。
        cursors.append({
            "owner_user_id": str(row.owner_user_id), "platform": row.platform,
            "bot_id": row.bot_id, "scope_type": row.scope_type, "scope_id": row.scope_id,
            "first_message_id": (row.last_reflected_message_id or 0) + 1,
            "last_message_id": row.last_message_id or 0,
        })
    state = {
        "status": "running", "done": 0, "total": len(cursors),
        "needs_review": 0, "failed": 0, "plan_ready": False, "ts": time.time(),
    }
    await redis.set(_IM_MODEL_PREVIEW_KEY, json.dumps(state, ensure_ascii=False), ex=3600)
    asyncio.create_task(_im_model_preview_worker(cursors, get_settings()))
    return {"ok": True, "total": len(cursors)}


@router.get("/memory/im-scopes/maintenance/model-preview/status")
async def im_memory_model_preview_status():
    from app.core.redis import get_redis

    raw = await get_redis().get(_IM_MODEL_PREVIEW_KEY)
    if not raw:
        return {"status": "idle", "done": 0, "total": 0, "needs_review": 0, "failed": 0, "plan_ready": False}
    return json.loads(raw if isinstance(raw, str) else raw.decode())


@router.post("/memory/im-scopes/maintenance/apply")
async def apply_im_memory_maintenance(
    body: ImMemoryMaintenanceRequest,
):
    """确认后应用最近一次模型预览计划；响应只返回汇总数量。"""
    if not body.confirm:
        raise HTTPException(400, "执行 IM 记忆维护需要 confirm=true")
    from agent.memory.im_reflection import _apply_output
    from agent.memory.scoped_store import read_scope
    from agent.memory.scopes import MemoryScope
    from app.core.redis import get_redis

    raw_state = await get_redis().get(_IM_MODEL_PREVIEW_KEY)
    raw_plan = await get_redis().get(_IM_MODEL_PREVIEW_PLAN_KEY)
    if not raw_state or not raw_plan:
        raise HTTPException(400, "没有可执行的模型预览，请先生成预览")
    state = json.loads(raw_state if isinstance(raw_state, str) else raw_state.decode())
    if state.get("status") != "done":
        raise HTTPException(400, "模型预览尚未完成")
    plans = json.loads(raw_plan if isinstance(raw_plan, str) else raw_plan.decode())
    applied = 0
    settings = get_settings()
    for item in plans:
        scope = MemoryScope(
            _uuid.UUID(item["owner_user_id"]), item["platform"], item["bot_id"],
            item["scope_type"], item["scope_id"],
        )
        current = await read_scope(scope)
        await _apply_output(scope, current, item.get("output") or {}, [], settings)
        applied += 1
    await get_redis().delete(_IM_MODEL_PREVIEW_PLAN_KEY)
    return {"ok": True, "applied": applied, "queued": applied}
