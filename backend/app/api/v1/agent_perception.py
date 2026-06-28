"""感知遥测聚合（Admin 面板数据源 · /admin/perception）。

读 Redis `perc:events`（reflection 写入的 capped list：perc + misperc 事件）→ 聚合成
总体均值 / intent 分布 / 误判率(overall + by intent + by model) / 异常标记。
**不建表**；依赖 P0 的感知遥测（见 docs/感知系统-架构升级.md §3.4 / §5）。脱敏:只聚合结构化字段。
"""
import json
import time
from collections import Counter, defaultdict

from fastapi import APIRouter

from app.core.redis import get_redis

router = APIRouter(prefix="/admin/perception", tags=["admin"])

_PERC_KEY = "perc:events"

# 异常阈值
_RATE_HI = 0.25        # 某 intent 误判率超此 → 标红
_MIN_N = 20            # 样本太少不下结论
_AMBIG_HI = 60         # 平均 ambiguity 偏高


def _avg(vals):
    nums = [v for v in vals if isinstance(v, (int, float))]
    return round(sum(nums) / len(nums), 1) if nums else None


@router.get("")
async def perception_stats(hours: int = 168, limit: int = 20000):
    """感知遥测总览。hours=时间窗（默认近 7 天，0=不限）;limit=最多读多少条事件。"""
    r = get_redis()
    raw = await r.lrange(_PERC_KEY, 0, limit - 1)
    events = []
    for x in raw:
        try:
            events.append(json.loads(x if isinstance(x, str) else x.decode()))
        except Exception:
            pass

    if hours:
        cutoff = int(time.time()) - hours * 3600
        events = [e for e in events if (e.get("ts") or 0) >= cutoff]

    perc = [e for e in events if e.get("t") == "perc"]
    misp = [e for e in events if e.get("t") == "misperc"]

    # 误判配对:同 user、按 ts 排序，misperc 归因到它前面最近一条 perc（被误判那轮）
    by_user = defaultdict(list)
    for e in events:
        by_user[e.get("u")].append(e)
    misperc_by_intent = Counter()
    misperc_by_model = Counter()
    for evs in by_user.values():
        evs.sort(key=lambda x: x.get("ts") or 0)
        last_perc = None
        for e in evs:
            if e.get("t") == "perc":
                last_perc = e
            elif e.get("t") == "misperc" and last_perc is not None:
                misperc_by_intent[last_perc.get("intent")] += 1
                misperc_by_model[last_perc.get("model")] += 1

    n = len(perc)
    intent_count = Counter(e.get("intent") for e in perc)
    model_count = Counter(e.get("model") for e in perc)
    emotion_count = Counter(e.get("emotion") for e in perc
                            if e.get("emotion") and e.get("emotion") != "无")

    by_intent = []
    for i, c in intent_count.most_common():
        m = misperc_by_intent.get(i, 0)
        by_intent.append({"intent": i, "count": c,
                          "pct": round(c / n * 100, 1) if n else 0,
                          "misperc": m,
                          "misperc_rate": round(m / c, 3) if c else None})

    by_model = []
    for mo, c in model_count.most_common():
        m = misperc_by_model.get(mo, 0)
        by_model.append({"model": mo or "(未知)", "count": c, "misperc": m,
                         "misperc_rate": round(m / c, 3) if c else None})

    avg_ambiguity = _avg([e.get("ambiguity") for e in perc])
    avg_emo = _avg([e.get("emo") for e in perc])

    # 异常标记（"偏高/不合理"自动挑出）
    flags = []
    for row in by_intent:
        if row["count"] >= _MIN_N and row["misperc_rate"] and row["misperc_rate"] > _RATE_HI:
            flags.append(f"intent「{row['intent']}」误判率偏高 {row['misperc_rate']:.0%}（n={row['count']}）")
    if avg_ambiguity is not None and avg_ambiguity > _AMBIG_HI:
        flags.append(f"平均 ambiguity 偏高 {avg_ambiguity}（模型普遍读不准 / 该多澄清）")
    if n >= 50 and (intent_count.get("情绪", 0) + intent_count.get("陪伴", 0)) == 0:
        flags.append("情绪/陪伴型占比为 0 —— 情绪需求可能被系统性误归类")
    # 某模型显著更差（n 够 + 比整体高一截）
    overall_rate = round(len(misp) / n, 3) if n else None
    if overall_rate is not None:
        for row in by_model:
            if row["count"] >= _MIN_N and row["misperc_rate"] and row["misperc_rate"] > overall_rate + 0.1:
                flags.append(f"模型「{row['model']}」误判率 {row['misperc_rate']:.0%} 明显高于整体 {overall_rate:.0%}")

    return {
        "window_hours": hours,
        "perc_total": n,
        "misperc_total": len(misp),
        "overall_misperc_rate": overall_rate,
        "avg_ambiguity": avg_ambiguity,
        "avg_emo_strength": avg_emo,
        "intent_distribution": by_intent,
        "by_model": by_model,
        "emotion_distribution": [{"emotion": k, "count": v} for k, v in emotion_count.most_common()],
        "flags": flags,
    }
