"""关系温度（Relationship 层第一个可落地的数据结构，见 docs/agent/proposals/反馈信号系统-设计.md §4.2）。

温度 = 滑动窗口（28 天）聚合的「当下互动质量」:回访节奏 + 会话深度 + 主动分享 + 正/负延续比。
动力学:**有上限**（各分量归一化饱和——防刷 + 语气档位封顶）;**冷却 = 窗口本身**（不互动旧信号
滑出窗口值自然落,不叠半衰期防双重衰减）。⚠️ 温度（快变·体温）≠ 深度（慢变·年轮）——本模块只算温度。

纪律:**温度只喂语气校准,不进语义记忆**（温度低=最近互动少,是事实;「用户疏远了」是危险推断,
禁止反思把它写成 observation）。v1 = 算 + 存（`.agent/temp.json`）,注入语气定档是后续。
计算触发:reflect() 末尾、现存 temp 超 24h 旧才重算（温度是周维度量,变化慢）。
"""
from __future__ import annotations

import json
import time

WINDOW_DAYS = 28          # 滑动窗口:4 周
RECOMPUTE_AFTER = 86400   # 现存温度超 24h 旧才重算

# 分量饱和线（到线即满分——上限的来源）
_SAT_ACTIVE_DAYS = 12     # 28 天里 12 天有对话 → 回访满分（≈隔天聊）
_SAT_DEPTH = 12           # 平均每会话 12 轮用户消息 → 深度满分
_SAT_SHARE = 8            # 窗口内 8 次主动分享 → 满分

# 合成权重（粗调起步,攒数据后校准）
_W = {"visit": 0.30, "depth": 0.25, "share": 0.25, "valence": 0.20}

_POS = {"顺着聊", "确认夸赞", "主动分享"}
_NEG = {"无视跳开", "改写重问"}


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


async def _fb_counts(user_id) -> dict:
    """近窗口内该用户的 feedback 信号计数（读 Redis perc:events,t=fb）。失败 → 全零。"""
    out = {"share": 0, "pos": 0, "neg": 0}
    try:
        from app.core.redis import get_redis
        u8 = str(user_id)[:8]
        cutoff = time.time() - WINDOW_DAYS * 86400
        raw = await get_redis().lrange("perc:events", 0, 20000 - 1)
        for x in raw:
            try:
                e = json.loads(x if isinstance(x, str) else x.decode())
            except Exception:
                continue
            if e.get("t") != "fb" or e.get("u") != u8 or (e.get("ts") or 0) < cutoff:
                continue
            v = e.get("v")
            if v == "主动分享":
                out["share"] += 1
            if v in _POS:
                out["pos"] += 1
            elif v in _NEG:
                out["neg"] += 1
    except Exception:
        pass
    return out


async def _chat_stats(user_id, db) -> dict:
    """近窗口的回访天数 + 平均会话深度（纯 SQL,轻量）。失败 → 全零。"""
    out = {"active_days": 0, "avg_depth": 0.0}
    try:
        from datetime import datetime, timedelta
        from sqlalchemy import text
        since = datetime.utcnow() - timedelta(days=WINDOW_DAYS)
        row = (await db.execute(text("""
            SELECT COUNT(DISTINCT DATE(m.created_at))::int AS days,
                   COALESCE(AVG(t.turns), 0)::float AS depth
            FROM conversation_messages m
            JOIN conversation_sessions s ON s.id = m.session_id
            LEFT JOIN (
                SELECT m2.session_id, COUNT(*)::int AS turns
                FROM conversation_messages m2
                WHERE m2.role = 'user' AND m2.created_at >= :since
                GROUP BY m2.session_id
            ) t ON t.session_id = s.id
            WHERE s.user_id = :uid AND m.role = 'user' AND m.created_at >= :since
        """), {"uid": str(user_id), "since": since})).first()
        if row:
            out["active_days"] = int(row.days or 0)
            out["avg_depth"] = float(row.depth or 0.0)
    except Exception:
        pass
    return out


async def compute(user_id, db) -> dict:
    """算当前温度。返回 {"temp": 0-1, "components": {...}, "ts": epoch}。"""
    fb = await _fb_counts(user_id)
    chat = await _chat_stats(user_id, db)

    visit = _clamp01(chat["active_days"] / _SAT_ACTIVE_DAYS)
    depth = _clamp01(chat["avg_depth"] / _SAT_DEPTH)
    share = _clamp01(fb["share"] / _SAT_SHARE)
    # 正负延续比:无信号时中性 0.5（没证据不奖不罚）
    total = fb["pos"] + fb["neg"]
    valence = 0.5 if total == 0 else _clamp01(fb["pos"] / total)

    temp = round(_W["visit"] * visit + _W["depth"] * depth
                 + _W["share"] * share + _W["valence"] * valence, 3)
    return {
        "temp": temp,
        "components": {
            "visit": round(visit, 3), "depth": round(depth, 3),
            "share": round(share, 3), "valence": round(valence, 3),
            "raw": {"active_days": chat["active_days"], "avg_depth": round(chat["avg_depth"], 1),
                    "share_n": fb["share"], "pos": fb["pos"], "neg": fb["neg"]},
        },
        "window_days": WINDOW_DAYS,
        "ts": time.time(),
    }


async def maybe_refresh(user_id) -> None:
    """reflect() 末尾调:现存温度超 24h 旧才重算并写 `.agent/temp.json`。自带 DB 会话,永不抛。"""
    try:
        from agent.memory import store
        cur = await store.read_temperature(user_id)
        if cur and (time.time() - (cur.get("ts") or 0)) < RECOMPUTE_AFTER:
            return
        from app.db.session import get_db
        async for db in get_db():
            data = await compute(user_id, db)
            await store.write_temperature(user_id, data)
            break
    except Exception:
        pass   # 温度是锦上添花,失败不影响任何主流程
