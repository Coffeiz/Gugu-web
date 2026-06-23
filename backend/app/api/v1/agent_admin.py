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
"""

import json
import uuid as _uuid
from datetime import datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func, text, literal_column
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import OVERRIDE_FILE, get_settings
from app.db.session import get_db
from app.models import AgentUsage

# ── 预设辅助函数 ──────────────────────────────────────────────────────────────

def _read_override() -> dict:
    if not OVERRIDE_FILE.exists():
        return {}
    try:
        return json.loads(OVERRIDE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_override(data: dict):
    OVERRIDE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    get_settings.cache_clear()


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return key[:3] + "•" * (len(key) - 7) + key[-4:]


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
    }
    presets = {"active_id": "default", "items": [item]}
    override["ai_presets"] = presets
    return presets

router = APIRouter(prefix="/admin/agent", tags=["admin"])

PROMPTS_DIR = Path(__file__).parent.parent.parent.parent / "agent" / "prompts"

PROFILES = ["default"]   # qqbot/mini 是早期占位、从未接线（运行时只用 default），已移除以免空 tab 误导

PLACEHOLDERS = [
    {"key": "{today}",       "desc": "今天日期"},
    {"key": "{summary}",     "desc": "当前状态快照（summary.md）"},
    {"key": "{facts}",       "desc": "咕咕观察到的客观事实（facts.json 导出）"},
    {"key": "{preferences}", "desc": "咕咕对用户偏好的理解（preferences.md）"},
    {"key": "{memory}",      "desc": "长期认知积累（memory.md）"},
    {"key": "{weekly}",      "desc": "本周记忆摘要"},
    {"key": "{daily}",       "desc": "近期每日记录"},
    {"key": "{projects}",    "desc": "用户当前项目列表"},
    {"key": "{calendar}",    "desc": "近期日历事件"},
    {"key": "{name}",        "desc": "用户昵称（identity.json，通常放 persona.md）"},
]


# 非对话 profile 的特殊可编辑 prompt：persona（人格）、skills（工具使用准则）、
# reflection（反思提炼）、compress（记忆压缩）
SPECIAL_PROMPTS = ["persona", "skills", "reflection", "compress"]


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
            func.coalesce(func.sum(AgentUsage.tokens_in), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
        )
    )
    total_calls, total_in, total_out = total_row.one()

    # 今日
    today = datetime.utcnow().date()
    today_start = datetime(today.year, today.month, today.day)
    today_row = await db.execute(
        select(
            func.count(AgentUsage.id),
            func.coalesce(func.sum(AgentUsage.tokens_in), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
        ).where(AgentUsage.created_at >= today_start)
    )
    today_calls, today_in, today_out = today_row.one()

    # 按 model 分组
    model_rows = await db.execute(
        select(
            AgentUsage.model,
            AgentUsage.provider,
            func.count(AgentUsage.id),
            func.coalesce(func.sum(AgentUsage.tokens_in), 0),
            func.coalesce(func.sum(AgentUsage.tokens_out), 0),
        ).group_by(AgentUsage.model, AgentUsage.provider)
        .order_by(func.count(AgentUsage.id).desc())
    )
    by_model = [
        {"model": r[0], "provider": r[1], "calls": r[2], "tokens_in": r[3], "tokens_out": r[4]}
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
                   COALESCE(SUM(tokens_in), 0) AS tokens_in,
                   COALESCE(SUM(tokens_out), 0) AS tokens_out
            FROM agent_usage
            WHERE created_at >= :month_start AND created_at <= :month_end
    """
    daily_params = {"month_start": month_start, "month_end": month_end}
    if model:
        daily_sql += " AND model = :model"
        daily_params["model"] = model
    daily_sql += " GROUP BY to_char(created_at, 'YYYY-MM-DD') ORDER BY day"
    daily_rows = await db.execute(text(daily_sql), daily_params)
    daily_map = {r[0]: {"calls": r[1], "tokens_in": r[2], "tokens_out": r[3]}
                 for r in daily_rows.all()}

    from datetime import date
    daily = []
    for d in range(1, days_in_month + 1):
        key = date(year, mon, d).isoformat()
        entry = daily_map.get(key, {"calls": 0, "tokens_in": 0, "tokens_out": 0})
        daily.append({"date": key, **entry})

    return {
        "total":   {"calls": total_calls, "tokens_in": total_in,   "tokens_out": total_out},
        "today":   {"calls": today_calls, "tokens_in": today_in,   "tokens_out": today_out},
        "by_model": by_model,
        "active_model": model,
        "months":   available_months,
        "month":    target_month,
        "daily":    daily,
    }


# ── LLM 预设 CRUD ─────────────────────────────────────────────────────────────

@router.get("/llm-presets")
async def list_llm_presets():
    override = _read_override()
    had_presets = "ai_presets" in override
    presets = _ensure_presets(override)
    if not had_presets:
        _write_override(override)
    items = [
        {**item, "api_key": _mask_key(item.get("api_key", ""))}
        for item in presets.get("items", [])
    ]
    return {"active_id": presets.get("active_id", ""), "items": items}


class PresetCreate(BaseModel):
    name: str
    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 2000
    temperature: float = 0.7
    context_tokens: int = 3000
    thinking: str = "disabled"


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
    }
    presets["items"].append(item)
    if not presets.get("active_id"):
        presets["active_id"] = new_id
        override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled"}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking")}
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
    if presets.get("active_id") == preset_id:
        override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled"}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking")}
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
    override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled"}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking")}
    _write_override(override)
    return {"active_id": preset_id}


@router.post("/llm-presets/{preset_id}/test")
async def test_llm_preset(preset_id: str):
    import httpx
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    provider = item.get("provider", "openai")
    api_key  = item.get("api_key", "")
    base_url = item.get("base_url", "").rstrip("/")
    model    = item.get("model", "")
    try:
        if provider == "anthropic":
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            url = f"{base_url}/messages"
            payload = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}
        else:
            headers = {"Authorization": f"Bearer {api_key}", "content-type": "application/json"}
            url = f"{base_url}/chat/completions"
            payload = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
        ok = resp.status_code < 500
        return {"ok": ok, "status": resp.status_code, "detail": "" if ok else resp.text[:300]}
    except Exception as e:
        return {"ok": False, "status": 0, "detail": str(e)[:300]}


# IM 机器人接入：飞书 / QQ 都走「用户自带(BYO)」，在用户设置里管理
# （/me/bots、/me/feishu/connect、/me/qq/connect），不再有 Admin 共享频道 CRUD。
