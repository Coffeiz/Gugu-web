"""
Agent 管理接口（需要 Admin token）
GET  /api/v1/admin/agent/prompts              → 列出所有 profile
GET  /api/v1/admin/agent/prompts/{profile}    → 读取 prompt 内容
PUT  /api/v1/admin/agent/prompts/{profile}    → 写入 prompt 内容
"""

from datetime import datetime, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func, text, literal_column
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models import AgentUsage

router = APIRouter(prefix="/admin/agent", tags=["admin"])

PROMPTS_DIR = Path(__file__).parent.parent.parent.parent / "agent" / "prompts"

PROFILES = ["default", "qqbot", "mini"]

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


def _prompt_path(profile: str) -> Path:
    if profile not in PROFILES:
        raise HTTPException(400, f"未知 profile: {profile}，可选：{PROFILES}")
    return PROMPTS_DIR / f"{profile}.md"


@router.get("/prompts")
async def list_prompts():
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    profiles = []
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
