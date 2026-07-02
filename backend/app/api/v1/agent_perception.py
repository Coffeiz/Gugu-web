"""感知遥测聚合（Admin 面板数据源 · /admin/perception）。

读 Redis `perc:events`（reflection 写入的 capped list：perc + misperc 事件）→ 聚合。
**口径：只算「活跃用户」（窗口内 ≥ min_events 轮反思的用户，滤掉一次性/测试噪声），
且头部指标按「每用户先算、再跨用户平均」（宏平均），不让重度用户主导全局。**
不建表；依赖 P0 的感知遥测（见 docs/agent/10-感知系统.md §3.4 / §5）。脱敏:只聚合结构化字段。
"""
import json
import time
from collections import Counter, defaultdict

from fastapi import APIRouter, Response

from app.core.redis import get_redis

router = APIRouter(prefix="/admin/perception", tags=["admin"])

_PERC_KEY = "perc:events"
_MISREAD_KEY = "perc:misread_cases"   # 错读案例 live 列表（给面板预览；持久那份是 md，见 misread_export）

# 异常阈值（默认值；可由面板按 query 参数覆盖，仅影响本次「怎么看」，不改系统行为）
_RATE_HI = 0.25        # 某 intent 误判率超此 → 标红
_MIN_N = 10            # 该 intent 样本太少不下结论
_AMBIG_HI = 60         # 平均歧义度偏高


def _mean(xs, nd=1):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs), nd) if xs else None


@router.get("")
async def perception_stats(hours: int = 168, limit: int = 20000, min_events: int = 1,
                           rate_hi: float = _RATE_HI, min_n: int = _MIN_N, ambig_hi: float = _AMBIG_HI):
    """感知总览。hours=时间窗（默认 7 天，0=不限）;min_events=活跃用户门槛（窗口内 ≥N 轮反思）;
    rate_hi/min_n/ambig_hi=标红阈值（误判率/最小样本/歧义度），默认即原常量，仅改「怎么看」不改系统行为。"""
    thresholds = {"rate_hi": rate_hi, "min_n": min_n, "ambig_hi": ambig_hi}
    r = get_redis()
    raw = await r.lrange(_PERC_KEY, 0, limit - 1)
    events = []
    for x in raw:
        try:
            events.append(json.loads(x if isinstance(x, str) else x.decode()))
        except Exception:
            pass
    if hours:
        cutoff = time.time() - hours * 3600
        events = [e for e in events if (e.get("ts") or 0) >= cutoff]

    # 按用户分组
    by_user_all = defaultdict(list)
    by_user_perc = defaultdict(list)
    for e in events:
        u = e.get("u")
        by_user_all[u].append(e)
        if e.get("t") == "perc":
            by_user_perc[u].append(e)

    # 活跃用户 = 窗口内 perc 数 ≥ min_events（滤掉一次性/测试噪声）
    active = {u for u, evs in by_user_perc.items() if len(evs) >= min_events}

    perc = [e for e in events if e.get("t") == "perc" and e.get("u") in active]
    misp = [e for e in events if e.get("t") == "misperc" and e.get("u") in active]

    if not active:
        return {"window_hours": hours, "min_events": min_events, "thresholds": thresholds,
                "active_users": 0,
                "perc_total": 0, "misperc_total": 0, "overall_misperc_rate": None,
                "perception_misperc_rate": None, "misperc_by_kind": [],
                "avg_ambiguity": None, "avg_emo_strength": None,
                "intent_distribution": [], "by_model": [], "emotion_distribution": [],
                "feedback_distribution": [], "feedback_total": 0,
                "flags": [], "note": f"暂无活跃用户（窗口内对话 ≥{min_events} 轮的用户）—— 多聊几轮再看"}

    # 误判按 user+ts 相邻配对到「被误判那轮」的 intent/model（仅活跃用户内）。
    # 新：按 kind 分「感知误读」与「数据/执行错」——感知误判率才是本面板真正要优化的。
    per_user_misperc = Counter()        # 全部纠正（含数据错）
    per_user_perc_err = Counter()       # 仅「感知误读」
    misperc_by_intent = Counter()       # intent/model 维度沿用全部纠正口径
    misperc_by_model = Counter()
    misperc_by_kind = Counter()
    for u in active:
        evs = sorted(by_user_all[u], key=lambda x: x.get("ts") or 0)
        last_perc = None
        for e in evs:
            if e.get("t") == "perc":
                last_perc = e
            elif e.get("t") == "misperc" and last_perc is not None:
                per_user_misperc[u] += 1
                kind = e.get("kind") or "未判"
                misperc_by_kind[kind] += 1
                if kind == "感知误读":
                    per_user_perc_err[u] += 1
                misperc_by_intent[last_perc.get("intent")] += 1
                misperc_by_model[last_perc.get("model")] += 1

    # 每用户指标 → 宏平均（每用户先算、再跨用户平均，重度用户不主导）
    all_intents = set()
    for u in active:
        all_intents |= {e.get("intent") for e in by_user_perc[u]}
    user_avg_amb, user_avg_emo, user_rate, user_perc_rate = [], [], [], []
    intent_user_share = {i: [] for i in all_intents}   # intent → 各用户的占比（缺席补 0）
    for u in active:
        evs = by_user_perc[u]
        tot = len(evs)
        user_avg_amb.append(_mean([e.get("ambiguity") for e in evs]))
        user_avg_emo.append(_mean([e.get("emo") for e in evs]))
        user_rate.append(per_user_misperc.get(u, 0) / tot)
        user_perc_rate.append(per_user_perc_err.get(u, 0) / tot)
        ic = Counter(e.get("intent") for e in evs)
        for i in all_intents:
            intent_user_share[i].append(ic.get(i, 0) / tot)

    avg_ambiguity = _mean(user_avg_amb)
    avg_emo = _mean(user_avg_emo)
    overall_misperc_rate = round(sum(user_rate) / len(user_rate), 3) if user_rate else None
    # 感知误判率（仅「感知误读」kind，宏平均）—— 这才是本面板真正要优化的；数据/执行错另算
    perception_misperc_rate = round(sum(user_perc_rate) / len(user_perc_rate), 3) if user_perc_rate else None

    # intent 分布：占比=宏平均 share（按用户均权）；条数=活跃池计数；误判率=活跃池 micro
    pooled_intent = Counter(e.get("intent") for e in perc)
    by_intent = []
    for i in all_intents:
        shares = intent_user_share[i]
        share = sum(shares) / len(shares) if shares else 0
        c = pooled_intent.get(i, 0)
        m = misperc_by_intent.get(i, 0)
        by_intent.append({"intent": i, "pct": round(share * 100, 1), "count": c,
                          "misperc": m, "misperc_rate": round(m / c, 3) if c else None})
    by_intent.sort(key=lambda x: -x["pct"])

    pooled_model = Counter(e.get("model") for e in perc)
    by_model = []
    for mo, c in pooled_model.most_common():
        m = misperc_by_model.get(mo, 0)
        by_model.append({"model": mo or "(未知)", "count": c, "misperc": m,
                         "misperc_rate": round(m / c, 3) if c else None})

    emotion_count = Counter(e.get("emotion") for e in perc
                            if e.get("emotion") and e.get("emotion") != "无")

    # 反馈信号分布（t=fb,学习闭环的燃料;见 docs/agent/proposals/反馈信号系统-设计.md）
    fb_events = [e for e in events if e.get("t") == "fb" and e.get("u") in active]
    feedback_count = Counter(e.get("v") for e in fb_events if e.get("v"))

    # 异常标记
    flags = []
    for row in by_intent:
        if row["count"] >= min_n and row["misperc_rate"] and row["misperc_rate"] > rate_hi:
            flags.append(f"intent「{row['intent']}」误判率偏高 {row['misperc_rate']:.0%}（n={row['count']}）")
    if avg_ambiguity is not None and avg_ambiguity > ambig_hi:
        flags.append(f"平均歧义度偏高 {avg_ambiguity}（模型普遍读不准 / 该多澄清）")
    if len(perc) >= 50 and not any(x["intent"] in ("情绪", "陪伴") and x["count"] for x in by_intent):
        flags.append("情绪/陪伴型占比为 0 —— 情绪需求可能被系统性误归类")
    if overall_misperc_rate is not None:
        for row in by_model:
            if row["count"] >= min_n and row["misperc_rate"] and row["misperc_rate"] > overall_misperc_rate + 0.1:
                flags.append(f"模型「{row['model']}」误判率 {row['misperc_rate']:.0%} 明显高于整体 {overall_misperc_rate:.0%}")

    return {
        "window_hours": hours,
        "min_events": min_events,
        "thresholds": thresholds,
        "active_users": len(active),
        "perc_total": len(perc),
        "misperc_total": len(misp),
        "overall_misperc_rate": overall_misperc_rate,
        "perception_misperc_rate": perception_misperc_rate,
        "misperc_by_kind": [{"kind": k, "count": v} for k, v in misperc_by_kind.most_common()],
        "avg_ambiguity": avg_ambiguity,
        "avg_emo_strength": avg_emo,
        "intent_distribution": by_intent,
        "by_model": by_model,
        "emotion_distribution": [{"emotion": k, "count": v} for k, v in emotion_count.most_common()],
        "feedback_distribution": [{"feedback": k, "count": v} for k, v in feedback_count.most_common()],
        "feedback_total": len(fb_events),
        "flags": flags,
        "note": f"口径：活跃用户（窗口内 ≥{min_events} 轮）{len(active)} 人；头部指标按用户宏平均（重度用户不主导）",
    }


@router.get("/misread/recent")
async def misread_recent(n: int = 30):
    """最近 N 条错读案例（脱敏，给面板预览）。读 Redis live 列表 perc:misread_cases。"""
    n = max(1, min(int(n or 30), 200))
    r = get_redis()
    raw = await r.lrange(_MISREAD_KEY, 0, n - 1)
    cases = []
    for x in raw:
        try:
            cases.append(json.loads(x if isinstance(x, str) else x.decode()))
        except Exception:
            pass
    return {"total": len(cases), "cases": cases}


@router.get("/misread/export")
async def misread_export():
    """下载全局「错读反思记录」（md，已脱敏：只 read_as/actual/抽象 pattern，无用户原话）。"""
    from agent.memory import store
    md = await store.read_misread()
    body = md if md else "# 错读反思记录\n\n暂无——需发生一次「感知误读 + 用户纠正」才会记一条。\n"
    return Response(content=body, media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="misread_reflections.md"'})
