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
from app.models import AgentUsage, ConversationSession, ConversationMessage, User

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
# policy（内容政策）、reflection（反思提炼）、compress（记忆压缩）
SPECIAL_PROMPTS = ["persona", "skills", "policy", "reflection", "compress"]


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
        {**item, "api_key": _mask_key(item.get("api_key", "")), "in_pool": bool(item.get("in_pool", False))}
        for item in presets.get("items", [])
    ]
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
    vision: bool = False
    api_format: str = ""


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
        "vision": body.vision,
        "api_format": body.api_format,
    }
    presets["items"].append(item)
    if not presets.get("active_id"):
        presets["active_id"] = new_id
        override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled","vision":False,"api_format":""}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking", "vision", "api_format")}
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
    vision: bool | None = None
    api_format: str | None = None
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
    if body.vision is not None:
        item["vision"] = body.vision
    if body.api_format is not None:
        item["api_format"] = body.api_format
    if body.in_pool is not None:
        item["in_pool"] = body.in_pool
    if presets.get("active_id") == preset_id:
        override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled","vision":False,"api_format":""}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking", "vision", "api_format")}
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
    override["ai"] = {k: item.get(k, {"max_tokens":2000,"temperature":0.7,"context_tokens":3000,"thinking":"disabled","vision":False,"api_format":""}.get(k)) for k in ("provider", "api_key", "base_url", "model", "max_tokens", "temperature", "context_tokens", "thinking", "vision", "api_format")}
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
    from types import SimpleNamespace
    from agent.llm_select import use_anthropic_for
    is_anthropic = use_anthropic_for(SimpleNamespace(provider=provider, base_url=base_url, api_format=item.get("api_format", "")))
    _mimo = provider == "mimo" or "xiaomimimo" in base_url.lower()   # MiMo 用 api-key 头，非标准 Bearer
    try:
        if is_anthropic:
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            if _mimo:
                headers["api-key"] = api_key
            url = f"{base_url}/messages"
            payload = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}
        else:
            headers = {"Authorization": f"Bearer {api_key}", "content-type": "application/json"}
            if _mimo:
                headers["api-key"] = api_key
            url = f"{base_url}/chat/completions"
            payload = {"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
        ok = resp.status_code < 500
        return {"ok": ok, "status": resp.status_code, "detail": "" if ok else resp.text[:300]}
    except Exception as e:
        return {"ok": False, "status": 0, "detail": str(e)[:300]}


def _probe_png_b64() -> str:
    """纯 stdlib 造一张 8×8 实色 PNG 的 base64，用作多模态探测图（不依赖 Pillow）。"""
    import base64
    import struct
    import zlib
    w = h = 8
    row = b"\x00" + b"\xe0\x40\x40" * w          # 每行：filter 0 + 8 像素(RGB 暗红)
    idat = zlib.compress(row * h)
    def _chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))   # 8bit, RGB
           + _chunk(b"IDAT", idat)
           + _chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


async def _do_vision_probe(provider, api_key, base_url, model, api_format="") -> tuple:
    """发一张极小图给模型，看接不接受。用真正的 SDK 客户端（与 runner 同款），
    路径/鉴权头由 SDK 拼，避免手写 URL 在 minimax 这种 base_url 上猜错。
    返回 (supported, status, detail)：True=支持 / False=纯文本 / None=测不准。"""
    import httpx
    from types import SimpleNamespace
    from agent.llm_select import use_anthropic_for, anthropic_default_headers, openai_default_headers
    b64 = _probe_png_b64()
    q = "这张图是什么颜色？用一个词回答。"
    _ns = SimpleNamespace(provider=provider, base_url=base_url, api_key=api_key, api_format=api_format)
    # 与 runner 同一判定口（含显式 api_format）
    is_anthropic = use_anthropic_for(_ns)
    timeout = httpx.Timeout(connect=10.0, read=25.0, write=10.0, pool=5.0)
    try:
        if is_anthropic:
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=api_key or "dummy", base_url=base_url,
                                    http_client=httpx.AsyncClient(timeout=timeout),
                                    default_headers=anthropic_default_headers(_ns))
            await client.messages.create(model=model, max_tokens=16, messages=[{"role": "user", "content": [
                {"type": "text", "text": q},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            ]}])
        else:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=api_key or "dummy", base_url=base_url, timeout=timeout,
                                 default_headers=openai_default_headers(_ns))
            await client.chat.completions.create(model=model, max_tokens=16, messages=[{"role": "user", "content": [
                {"type": "text", "text": q},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]}])
        return True, 200, "模型接受了图片输入 ✅ 支持多模态"
    except Exception as e:
        sc = getattr(e, "status_code", None) or 0
        msg = str(e)[:200]
        if sc in (400, 422):
            # 鉴权过了、格式也对，却拒了图片块 → 多为纯文本模型不认 image
            return False, sc, f"模型拒绝了图片输入，应为纯文本模型：{msg}"
        if sc in (401, 403):
            return None, sc, f"鉴权失败（{sc}），先确认 Key/连通性再测"
        if sc == 404:
            return None, sc, f"模型名或地址不对（{sc}）：{msg}"
        return None, sc, f"未能判定：{msg}"


@router.post("/llm-presets/{preset_id}/probe-vision")
async def probe_vision_preset(preset_id: str):
    """探测预设模型是否支持多模态，并把明确结论（True/False）写回 vision 字段。"""
    override = _read_override()
    presets = _ensure_presets(override)
    item = next((it for it in presets["items"] if it["id"] == preset_id), None)
    if not item:
        raise HTTPException(404, "预设不存在")
    supported, sc, detail = await _do_vision_probe(
        item.get("provider", "openai"), item.get("api_key", ""),
        item.get("base_url", "").rstrip("/"), item.get("model", ""),
        item.get("api_format", ""))
    if supported is not None:   # 结论明确才落库
        item["vision"] = supported
        if presets.get("active_id") == preset_id:
            override.setdefault("ai", {})["vision"] = supported
        _write_override(override)
    return {"supported": supported, "status": sc, "detail": detail}


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
    """content_json 块脱敏：保留 text/tool_use/tool_result 的结构与工具名，正文与结果内容打码。"""
    if not blocks:
        return blocks
    out = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": _redact_text(b.get("text", ""))})
        elif t == "tool_use":
            out.append({"type": "tool_use", "name": b.get("name"), "input": _redact_args(b.get("input") or {})})
        elif t == "tool_result":
            out.append({"type": "tool_result", "is_error": bool(b.get("is_error")), "content": "〔结果已隐藏〕"})
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
