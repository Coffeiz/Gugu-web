"""对话后反思：提炼画像、行为模式与近期记忆的增量。

复用 settings.ai 的 provider 做一次廉价非流式调用，产出 JSON：
  {"profile_add": [{"type": "...", "text": "..."}], "pattern_add": [...], "daily": "...", "summary": "..."}
profile=稳定身份/偏好，pattern=可复用行为习惯，daily=本次流水，summary=当下状态快照。
perception=本轮观察（感知遥测，只打点 `agent.perc` 日志，不写记忆、不影响回复）。
由 web/IM 在对话结束后 fire-and-forget 调用，不阻塞、失败不影响主流程。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path

from agent.memory import store
from agent.context.branch import ContextBranch
from agent.context.branch_types import BranchInput, BranchPolicy

# 保持后台任务引用，防止被 GC（fire-and-forget 必须）
_bg_tasks: set = set()

# 感知遥测/误判 日志（与 agent.traj 同套：靠 logging 配置落 gugu.log / Debug 面板；脱敏，不写用户原文）
_perc_log = logging.getLogger("agent.perc")
_memdiff_log = logging.getLogger("agent.memdiff")

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
# 文件缺失时的兜底（正常走 prompts/reflection.md，可热编辑 / Admin 在线改）
_SYS_FALLBACK = (
    "你在帮咕咕维护对用户的长期记忆。稳定身份/喜好进 profile_add（对象数组，每条含 type 和 text），"
    "可复用的行为/决策习惯进 pattern_add（每条对象 {text, kind: observed=亲述/inferred=推断, importance: 1-5}）。"
    "阶段性事件不进两者，应写 daily 或 summary；不记世界常识、不评判用户，宁少勿多。"
    "被推翻/过时/被替换的旧条分别进 profile_remove 或 pattern_remove（字符串、尽量照抄原文）；"
    "没变动就都给空数组、别重列旧内容。"
    "summary 是一句「用户当下在忙什么/近期重心」的快照，基于原快照演进、没变就原样返回；"
    "涉及具体时间点一律换算成绝对日期（如「7/6 晚」而非「今晚」），照 user 消息开头给的当前日期换算。"
    "perception 是本轮观察（intent/ambiguity/emotion/emo_strength），照实判、只打点。"
    "knowledge_candidate 只在本轮出现有明确主题、可长期复用的事实或规则时给，格式为 {should_reflect:boolean,query:string}；"
    "普通闲聊、一次性进展、用户画像/习惯、纯工具操作时 should_reflect 必须为 false。"
    "correction 唯一判 true 的条件：错的主体是**你（咕咕）本人这次的回答/理解**（用户说「你错了/不是这个/我说的是…」）。"
    "错的若是**别人**一律 false：用户认自己错/确认你是对的（是我错了/你是对的/哦原来如此）、说第三方或外部信息错"
    "（他记错了/这数据源不对/官网写错了）、单纯聊「某事是错的」——都 false（句里有「错」字也不算）。"
    "kind 仅 true 时给——`感知误读`(没读懂用户要什么) / `数据或执行错`(读懂了但数据/操作做错)，拿不准偏后者。"
    "lens_hint：仅当本轮**确实暴露了一条「怎么读懂这个用户」的可复用规则**才写、绝大多数轮留空字符串"
    "（一次性误会、具体事实都不算）。固定格式『「触发语」→ 真实含义/应对』，触发语放「」里写关键几字"
    "（如『「随便」→ 其实有偏好要追问』），便于复现识别。"
    '严格只输出 JSON：{"profile_add": [{"type":"name|address|pronoun|background|preference|note", "text":"..."}], "profile_remove": ["..."], '
    '"pattern_add": [{"text": "...", "kind": "observed", "importance": 4}], "pattern_remove": ["..."], '
    '"daily": "一句话总结(没有就空字符串)", "summary": "当前状态快照(没有就空字符串)", "lens_hint": "", '
    '"correction": {"is_correction": false, "kind": ""}, '
    '"perception": {"intent": "情绪/查询/执行/...", "ambiguity": 0, "emotion": "无", "emo_strength": 0}, '
    '"knowledge_candidate": {"should_reflect": false, "query": ""}}'
)

# 误判捕获:主信号是反思 LLM 判的 correction（见 _misperc_llm，能分感知误读/数据执行错）；
# 正则只在 extract 失败时兜底（高精度、注定漏召回——短随意的纠正如「错了，…」抓不到）。
_CORRECTION_MARKERS = ("不是我", "我是说", "我的意思是", "你理解错", "理解错了", "我要的是",
                       "搞错了", "你弄错", "不是这个", "我说的是", "不对，", "不对,", "不是，", "不是,")
_CORRECTION_KINDS = {"感知误读", "数据或执行错"}   # LLM 判的纠正类型；面板据此拆「感知误判」与「数据/执行纠错」
_PERC_INTENTS = {"执行", "推进", "记录", "查询", "决策", "反思", "情绪", "陪伴", "闲聊"}
# 错读案例 miss 的「只认枚举」白名单：结构上杜绝脱敏泄漏（free-text 会行内夹带，证明不可靠）
_MISS_NEEDS = _PERC_INTENTS | {"指代旧事"}                 # read_as / actual 的需求类型
_MISS_PATTERNS = {"潜台词漏读", "情绪当任务", "过度共情", "指代漏接", "答非所问", "场景惯性", "过度澄清"}  # 错读模式
# 反馈信号枚举（学习闭环的燃料，见 proposals/反馈信号系统-设计.md）：枚举外一律当「无信号」丢弃
_FEEDBACK_ENUM = {"顺着聊", "无视跳开", "改写重问", "主动分享", "确认夸赞"}   # 「无信号」不打点
_LAST_TURN_TTL = 86400   # 上一轮缓存 24h（仅作陈旧上限）：延续性靠 session 判，不靠时间窗
                         # ——有了 session 闸后可放宽到一天，让同会话隔几小时回来接上话题也算延续
_PROFILE_TEMPORAL_RE = re.compile(r"(最近|刚|刚刚|这阵子|这几天|这周|本周|目前|现在|近期)")


_PERC_KEY = "perc:events"    # Redis capped list:给 Admin 聚合面板（/admin/perception）读
_PERC_CAP = 20000
_MISREAD_KEY = "perc:misread_cases"   # 错读需求案例收集（带脱敏 miss 诊断，便于翻「具体原因」）
_MISREAD_CAP = 500
GROUP_OWNER_BATCH_SIZE = 5
GROUP_OWNER_IDLE_SECONDS = 15 * 60
_GROUP_OWNER_BUFFER_PREFIX = "memory:owner-group-reflection:"
_GROUP_OWNER_IDLE_KEY = "memory:owner-group-reflection-idle"


def _now_ts() -> float:
    import time
    return time.time()   # 真 epoch 浮点（保留亚秒序，误判配对才不乱；别用 utcnow().timestamp() 跨时区会偏）


def _misperc_llm(user_id, corr) -> dict | None:
    """反思 LLM 判定的纠正 → misperc（带 kind=感知误读/数据或执行错，via=llm）。主信号。
    corr 来自 _extract 的 out['correction']；非纠正或格式不对 → None（不记）。"""
    if not isinstance(corr, dict) or not corr.get("is_correction"):
        return None
    kind = corr.get("kind")
    kind = kind if kind in _CORRECTION_KINDS else "未判"
    rec = {"t": "misperc", "u": str(user_id)[:8], "kind": kind, "via": "llm", "ts": _now_ts()}
    # 感知误读 → 顺带收一条「错读案例」（脱敏结构化诊断：read_as/actual/pattern，截断兜底防夹带原文）
    miss = corr.get("miss")
    if kind == "感知误读" and isinstance(miss, dict):
        # 脱敏:三字段只认固定枚举，枚举外（含任何夹带具体内容的）一律落「其他」——结构上杜绝泄漏
        def _enum(v, allowed):
            v = str(v or "").strip()
            return v if v in allowed else "其他"
        m = {"read_as": _enum(miss.get("read_as"), _MISS_NEEDS),
             "actual": _enum(miss.get("actual"), _MISS_NEEDS),
             "pattern": _enum(miss.get("pattern"), _MISS_PATTERNS)}
        if set(m.values()) != {"其他"}:   # 全是「其他」= 没信息，不记
            rec["miss"] = m
    return rec


def _misperc_regex(user_id, user_msg: str) -> dict | None:
    """正则兜底（仅 extract 失败时用）：这句开头像纠正 → misperc（kind 未判、via=regex）。
    高精度、注定漏召回（短随意纠正抓不到），所以只当 LLM 不可用时的保底。"""
    head = (user_msg or "").strip()[:16]
    hit = next((m for m in _CORRECTION_MARKERS if m in head), None)
    if not hit:
        return None
    return {"t": "misperc", "u": str(user_id)[:8], "kind": "未判", "via": "regex", "marker": hit, "ts": _now_ts()}


def _perc_rec(user_id, perc, model: str) -> dict | None:
    """本轮观察 → 一条 perc 记录（只结构化字段，不写用户原文）。"""
    if not isinstance(perc, dict):
        return None
    intent = perc.get("intent")
    return {"t": "perc", "u": str(user_id)[:8], "model": model or "",
            "intent": intent if intent in _PERC_INTENTS else "其他",
            "ambiguity": perc.get("ambiguity"), "emotion": perc.get("emotion"),
            "emo": perc.get("emo_strength"), "ts": _now_ts()}


def _fb_rec(user_id, fb) -> dict | None:
    """反思判的 feedback 枚举 → 一条 fb 记录（白名单校验,「无信号」/枚举外不打点）。"""
    fb = str(fb or "").strip()
    if fb not in _FEEDBACK_ENUM:
        return None
    return {"t": "fb", "u": str(user_id)[:8], "v": fb, "ts": _now_ts()}


def _last_turn_key(user_id) -> str:
    return f"lastturn:{user_id}"


async def _read_last_turn(user_id, session_id=None) -> dict | None:
    """读上一轮 {u: 用户消息, a: 咕咕回复}（判 feedback 的对照物）。
    **延续性按 session 判**：存的 session 与本轮不同 → 视为「另起对话」，返回 None（不跨会话比）。
    无/过期/换会话/异常 → None。"""
    try:
        from app.core.redis import get_redis
        raw = await get_redis().get(_last_turn_key(user_id))
        if not raw:
            return None
        d = json.loads(raw if isinstance(raw, str) else raw.decode())
        if not isinstance(d, dict):
            return None
        # session 闸：不是同一会话就不算延续（换了话题/新对话，别拿上段的话当上一轮）
        if session_id is not None and str(d.get("sid") or "") != str(session_id):
            return None
        return {"u": d.get("u", ""), "a": d.get("a", "")}
    except Exception:
        return None


async def _write_last_turn(user_id, user_msg: str, assistant_reply: str, session_id=None) -> None:
    """把本轮存为「上一轮」缓存（带 session_id 供下轮判延续;截断防膨胀;TTL 24h 陈旧上限）。永不抛。"""
    try:
        from app.core.redis import get_redis
        payload = json.dumps({"u": (user_msg or "")[:200], "a": (assistant_reply or "")[:300],
                              "sid": str(session_id) if session_id is not None else ""},
                             ensure_ascii=False)
        await get_redis().set(_last_turn_key(user_id), payload, ex=_LAST_TURN_TTL)
    except Exception:
        pass


async def _emit_perc(rec: dict | None) -> None:
    """打 agent.perc 日志(trace/grep) + 推 Redis capped list(给聚合面板)。永不抛、不影响反思。"""
    if not rec:
        return
    line = json.dumps(rec, ensure_ascii=False)
    try:
        _perc_log.info(line)
    except Exception:
        pass
    try:
        from app.core.redis import get_redis
        r = get_redis()
        await r.lpush(_PERC_KEY, line)
        await r.ltrim(_PERC_KEY, 0, _PERC_CAP - 1)
        # 带 miss 诊断的感知误读 → 另收进案例列表，便于翻「具体原因」（已脱敏）
        if rec.get("t") == "misperc" and rec.get("miss"):
            await r.lpush(_MISREAD_KEY, line)
            await r.ltrim(_MISREAD_KEY, 0, _MISREAD_CAP - 1)
    except Exception:
        pass
    # 持久化:把感知误读反思块追加进全局 md（跨 Redis 持久 + 可下载，已脱敏）。独立于 Redis、失败不影响。
    if rec.get("t") == "misperc" and rec.get("miss"):
        try:
            m = rec["miss"]
            when = datetime.fromtimestamp(rec.get("ts") or 0).strftime("%Y-%m-%d %H:%M")
            entry = (f"## {when} · u={rec.get('u')} · 感知误读\n"
                     f"- 读成：{m.get('read_as') or '—'}\n"
                     f"- 实际：{m.get('actual') or '—'}\n"
                     f"- 反思：{m.get('pattern') or '—'}")
            await store.append_misread(entry)
        except Exception:
            pass


def _load_sys() -> str:
    """每次现读 reflection.md（热生效）；缺失则用兜底。"""
    try:
        return (_PROMPTS_DIR / "reflection.md").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return _SYS_FALLBACK


# 纯应答 / 寒暄词：用户消息整条命中才跳过反思（精确匹配，长句不误伤）
_TRIVIAL = frozenset({
    "嗯", "嗯嗯", "嗯呢", "好", "好的", "好滴", "好哒", "行", "行吧", "成", "中",
    "哦", "哦哦", "噢", "ok", "okay", "okk", "k", "谢谢", "谢了", "多谢", "thanks", "thx",
    "收到", "了解", "明白", "懂了", "哈哈", "哈哈哈", "嘿嘿", "可以", "对", "对的",
    "是", "是的", "没了", "没事", "不用了", "辛苦了", "👍", "👌", "🙏", "666", "赞", "嗯嗯嗯",
})
_STRIP = " \t\n　。，、！？～~.,!?;:…“”\"'（）()【】[]"


def _worth_reflecting(user_msg: str) -> bool:
    """整条消息是纯应答/寒暄词则不值得反思（省一次 LLM 调用）。保守：只挡明确废话。"""
    cleaned = (user_msg or "").strip(_STRIP).strip().lower()
    if not cleaned:
        return False
    return cleaned not in _TRIVIAL


def _split_profile_adds(items: list) -> tuple[list[dict], list[str]]:
    """把明显阶段性的 profile 候选拦下，转去 daily/memory 侧。"""
    profile_adds: list[dict] = []
    staged_events: list[str] = []
    for raw in items or []:
        if isinstance(raw, dict):
            text = str(raw.get("text") or "").strip()
            item_type = str(raw.get("type") or "note")
        else:
            text, item_type = str(raw or "").strip(), "note"
        if not text:
            continue
        if item_type not in store.PROFILE_TYPES:
            item_type = "note"
        if _PROFILE_TEMPORAL_RE.search(text):
            staged_events.append(text)
            continue
        profile_adds.append({"type": item_type, "text": text})
    return profile_adds, staged_events


def _merge_daily_note(daily_note: str, staged_events: list[str]) -> str:
    """被 profile 闸门拦下的阶段性事件并回 daily，避免信息直接丢掉。"""
    events = [text for text in staged_events if text and text not in daily_note]
    if not events:
        return daily_note
    if daily_note:
        return f"{daily_note}；" + "；".join(events)
    return "；".join(events)


def _owner_group_buffer_key(user_id) -> str:
    return f"{_GROUP_OWNER_BUFFER_PREFIX}{user_id}"


async def _drain_group_owner_buffer(user_id, settings) -> None:
    """原子取走一批 owner 群聊反思，失败时把消息放回 Redis。"""
    from app.core import redis as R

    redis = R.get_redis()
    lock = redis.lock(f"{_GROUP_OWNER_BUFFER_PREFIX}lock:{user_id}", timeout=180)
    if not await lock.acquire(blocking=False):
        return
    rows = []
    try:
        raw_rows = await redis.lrange(_owner_group_buffer_key(user_id), 0, -1)
        if not raw_rows:
            await redis.zrem(_GROUP_OWNER_IDLE_KEY, str(user_id))
            return
        rows = [json.loads(raw) for raw in raw_rows]
        await redis.delete(_owner_group_buffer_key(user_id))
        await redis.zrem(_GROUP_OWNER_IDLE_KEY, str(user_id))
        ok = await reflect(
            user_id,
            rows[-1].get("user_name", ""),
            "\n".join(row.get("user_msg", "") for row in rows),
            "\n".join(row.get("assistant_reply", "") for row in rows),
            settings,
            session_id=rows[-1].get("session_id"),
            turns=rows,
        )
        if not ok:
            raise RuntimeError("owner_group_reflection_failed")
    except Exception:
        if rows:
            await redis.rpush(
                _owner_group_buffer_key(user_id),
                *[json.dumps(row, ensure_ascii=False) for row in rows],
            )
            await redis.zadd(_GROUP_OWNER_IDLE_KEY, {str(user_id): time.time()})
    finally:
        try:
            await lock.release()
        except Exception:
            pass


async def flush_due_group_owner_reflections(settings, *, now: float | None = None, limit: int = 50) -> int:
    """收束连续 15 分钟没有新群消息的 owner 反思缓冲。"""
    from app.core import redis as R

    cutoff = (now if now is not None else time.time()) - GROUP_OWNER_IDLE_SECONDS
    users = await R.get_redis().zrangebyscore(_GROUP_OWNER_IDLE_KEY, 0, cutoff, start=0, num=limit)
    for user_id in users:
        task = asyncio.create_task(_drain_group_owner_buffer(user_id, settings))
        _bg_tasks.add(task)
        task.add_done_callback(_bg_tasks.discard)
    return len(users)


def schedule(user_id, user_name, user_msg, assistant_reply, settings, used_tools=None, session_id=None,
             group_mode: bool = False) -> None:
    """非阻塞触发一次反思。琐碎应答（嗯/好的/谢谢…）默认跳过省调用——
    但若这轮咕咕**用了工具**（如「要建项目吗？」→「嗯」→真建了），即便用户只说「嗯」也反思，
    以记下这轮做了啥（daily/summary）。used_tools 传列表(web)或 bool(IM 代理)皆可，truthy 即视为有动作。
    session_id 供 feedback 判「是否延续同一对话」（换会话不跨比，见 _read_last_turn）。"""
    if not group_mode and not _worth_reflecting(user_msg) and not used_tools:
        return
    if group_mode:
        task = asyncio.create_task(_schedule_group_owner(
            user_id, user_name, user_msg, assistant_reply, settings,
            bool(used_tools), session_id,
        ))
        _bg_tasks.add(task)
        task.add_done_callback(_bg_tasks.discard)
        return
    task = asyncio.create_task(
        reflect(user_id, user_name, user_msg, assistant_reply, settings, session_id=session_id)
    )
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _schedule_group_owner(user_id, user_name, user_msg, assistant_reply, settings,
                                used_tools: bool, session_id=None) -> None:
    from app.core import redis as R

    redis = R.get_redis()
    key = _owner_group_buffer_key(user_id)
    row = {
        "user_name": user_name,
        "user_msg": user_msg,
        "assistant_reply": assistant_reply,
        "session_id": session_id,
    }
    await redis.rpush(key, json.dumps(row, ensure_ascii=False))
    await redis.zadd(_GROUP_OWNER_IDLE_KEY, {str(user_id): time.time()})
    count = await redis.llen(key)
    if used_tools or count >= GROUP_OWNER_BATCH_SIZE:
        await _drain_group_owner_buffer(user_id, settings)


async def reflect(user_id, user_name, user_msg, assistant_reply, settings, session_id=None,
                  turns=None) -> bool:
    out = None
    turns = turns or [{
        "user_msg": user_msg,
        "assistant_reply": assistant_reply,
        "user_name": user_name,
        "session_id": session_id,
    }]
    prev_turn = await _read_last_turn(user_id, session_id)   # 上一轮（判 feedback），换会话/过期 → None
    try:
        mem = await store.read_memory(user_id)
        existing_summary = mem.get("summary", "")
        out = await _extract(user_name, user_msg, assistant_reply, mem["profile"], mem["pattern"], existing_summary,
                             settings, prev_turn=prev_turn)
    except Exception:
        out = None
    # 无论 extract 成败，都把本轮存为「上一轮」缓存（带 session_id，下轮据此判是否延续）
    last = turns[-1]
    await _write_last_turn(user_id, last.get("user_msg", ""), last.get("assistant_reply", ""), last.get("session_id"))

    # 误判捕获:优先信反思 LLM 判的 correction（能分「感知误读 vs 数据/执行错」，正则做不到）；
    # extract 没成（{} / 异常）才退回正则兜底（高精度、漏召回）。二选一，不重复计。
    if isinstance(out, dict) and out:
        await _emit_perc(_misperc_llm(user_id, out.get("correction")))
    else:
        await _emit_perc(_misperc_regex(user_id, user_msg))
        return False  # extract 没结果，记忆增量/summary 无从写

    try:
        # 感知遥测:把本轮 perception 打日志 + 推 Redis（不写记忆）
        await _emit_perc(_perc_rec(user_id, out.get("perception"), getattr(getattr(settings, "ai", None), "model", "")))
        # 反馈信号（feedback 枚举,白名单校验）:学习闭环的燃料,只打点（见 proposals/反馈信号系统-设计.md）
        await _emit_perc(_fb_rec(user_id, out.get("feedback")))
        # 行为模块选择：把本轮 stance（= perception.intent）落 per-user，供下一轮 builder 点亮模块（带新鲜度闸）
        await store.write_stance(user_id, (out.get("perception") or {}).get("intent"))
        daily_note = (out.get("daily") or "").strip()
        summary = (out.get("summary") or "").strip()

        # profile 更新：身份/稳定喜好，按 type/text/ts 保存，不保留机器 id。
        p_add, p_rem = out.get("profile_add"), out.get("profile_remove")
        if p_add is not None or p_rem is not None:
            p_add, staged_profile_events = _split_profile_adds(p_add or [])
            daily_note = _merge_daily_note(daily_note, staged_profile_events)
            cur_p = await store.read_profile_list(user_id)
            new_p = store.apply_profile_ops(cur_p, p_add, p_rem or [])
            if new_p != cur_p:
                await store.write_profile_list(user_id, new_p)
                from agent import events
                events.publish(events.types.MemoryUpdated(
                    user_id=user_id, added=len(p_add), removed=len(p_rem or []), source="reflection"))

        # pattern 更新（2b 结构化）：反思只吐增删 pattern_add(带 kind/importance)/pattern_remove，
        # apply_pattern_ops 应用到 pattern.json（命中相似条→印证升 conf，否则新增）。输出不随 pattern 增长。
        f_add, f_rem = out.get("pattern_add"), out.get("pattern_remove")
        legacy = out.get("facts")   # 旧 prompt 回显整份 facts（灰度兼容）→ 当 inferred 增量并入
        if f_add is not None or f_rem is not None or legacy:
            cur = await store.read_pattern_list(user_id)
            adds = f_add if f_add is not None else (legacy or [])
            new = store.apply_pattern_ops(cur, adds, f_rem or [])
            if new != cur:
                await store.write_pattern_list(user_id, new)
                await store.sync_pattern_vecs(user_id, new)   # 增量补向量缓存（embedding 未启用=no-op）
                from agent import events
                events.publish(events.types.MemoryUpdated(
                    user_id=user_id, added=len(adds or []), removed=len(f_rem or []), source="reflection"))
        # summary 同理：非空才覆盖、变了才写（防把已有快照清空/瞎改）。覆盖式更新没有版本历史，
        # 一旦某次反思判断错（该保留的重心被误判"变了"而冲掉），线上完全看不出来、只会表现成
        # "咕咕好像突然不记得之前的事了"这种模糊症状——记一行 旧→新 的 diff，出问题时至少能回放
        # 定位是哪一轮反思写坏的（devlog 2026-07-14，跟当晚 blocks schema 那轮"别猜、要看真实
        # 数据"的教训同源）。best-effort，记日志失败不影响主流程。
        if summary and summary != existing_summary.strip():
            try:
                from agent.security.logsafe import fingerprint
                _memdiff_log.info(
                    "summary user_fp=%s old_len=%d new_len=%d old_fp=%s new_fp=%s",
                    fingerprint(str(user_id)), len(existing_summary.strip()), len(summary),
                    fingerprint(existing_summary.strip()), fingerprint(summary),
                )
            except Exception:
                pass
            await store.write_summary(user_id, summary)
        if daily_note:
            await store.append_daily(user_id, datetime.now().strftime("%Y-%m-%d"), daily_note)
            # 写完 daily 顺带检查压缩：攒够则把最老的沉淀进 memory.md
            from agent.memory import compress
            await compress.compact(user_id, settings)
            from agent import events
            events.publish(events.types.RagIndexUpdated(
                user_id=user_id, source_type="memory", source_id="daily", operation="upsert",
            ))
        # lens（解读先验）gated 学习：hint 多数轮为空；候选须复现才提拔成规则。顺带做退休维护。
        from agent.memory import lens
        await lens.observe(user_id, out.get("lens_hint"))
        # 关系温度：超 24h 旧才重算（窗口聚合、纯数据侧、自带 DB 会话,见 memory/temperature.py）
        from agent.memory import temperature
        await temperature.maybe_refresh(user_id)
        # pattern 维护只在活跃反思链路中检查，不扫描沉默用户，也不阻塞本轮回复。
        from agent.memory import periodic
        await periodic.maybe_schedule(user_id, settings)
        # Knowledge 复用本轮 Memory 反思时机；只有 Memory 反思明确标记候选时才追加一次调用。
        try:
            from agent.knowledge.reflection import candidate_request, reflect_if_candidate
            should_reflect, query = candidate_request(out)
            if should_reflect:
                mode = "explicit" if _explicit_knowledge_request(user_msg) else "automatic"
                await reflect_if_candidate(
                    user_id, user_msg, assistant_reply, settings, query,
                    save_mode=mode, session_id=session_id,
                )
        except Exception:
            _memdiff_log.debug("knowledge reflection skipped", exc_info=True)
        try:
            from agent.security.logsafe import fingerprint
            _memdiff_log.info(
                "[memory-reflection-audit] phase=completed scope=owner user_fp=%s "
                "session_id=%s summary_changed=%s daily=%s profile_ops=%s pattern_ops=%s",
                fingerprint(str(user_id)),
                session_id,
                bool(summary and summary != existing_summary.strip()),
                bool(daily_note),
                bool(p_add is not None or p_rem is not None),
                bool(f_add is not None or f_rem is not None or legacy),
            )
        except Exception:
            pass
    except Exception:
        return False  # 反思是锦上添花，任何失败都不能影响对话
    return True


def _explicit_knowledge_request(text: str) -> bool:
    markers = ("记住", "保存到知识库", "加入知识库", "以后按这个规则", "把这个知识")
    return any(marker in (text or "") for marker in markers)


async def _extract(user_name, user_msg, assistant_reply, existing_profile, existing_pattern, existing_summary,
                   settings, prev_turn: dict | None = None) -> dict:
    # 上一轮（判 feedback 的对照物）:有才注入,没有则 prompt 里已说明「没给上一轮 → 无信号」
    prev_part = ""
    if prev_turn:
        prev_part = (f"【上一轮】\n用户：{prev_turn.get('u', '')}\n咕咕：{prev_turn.get('a', '')}\n\n")
    # 当前日期：不给的话模型没法把「今晚/明天/这周」这类相对时间换算成绝对日期写进 summary——
    # 快照隔几天被注入时,这些相对说法就已经读不出是哪天了（见 reflection.md summary 节的日期要求）。
    from app.core.tz import local_now
    _now = local_now()
    now_str = f"{_now.strftime('%Y-%m-%d')}（星期{'一二三四五六日'[_now.weekday()]}）{_now.strftime('%H:%M')}"
    user = (
        f"现在是 {now_str}。\n\n"
        f"已知的用户画像：\n{existing_profile or '（暂无）'}\n\n"
        f"已知的行为模式：\n{existing_pattern or '（暂无）'}\n\n"
        f"当前状态快照：\n{existing_summary or '（暂无）'}\n\n"
        f"{prev_part}"
        f"本次对话：\n用户({user_name})：{user_msg}\n咕咕：{assistant_reply}\n\n"
        f"请只报本轮 profile 的增删（profile_add 对象数组，type 只能是 name/address/pronoun/background/preference/note；profile_remove 字符串数组）"
        f"+ 本轮 pattern 的增删（pattern_add / pattern_remove，pattern_add 带 kind/importance）"
        f"——没变动就都给空数组、别重列旧内容"
        f"+ 当前状态快照（基于原快照演进、没变就原样返回、别清空）+ 本轮 perception（照本轮用户消息判、始终给）"
        f"+ feedback（用户这句相对【上一轮】的反馈,枚举选一,没给上一轮就 无信号）。"
        f"+ knowledge_candidate（仅明确、可复用的事实/规则才标 true，并给一个用于 Knowledge RAG 的短查询）。"
    )
    # 2b：反思只吐 profile/pattern 的增删（delta）+ daily/summary/perception，输出体量**不再随存量增长**，
    # 根治了「pattern 一多 → 回显整份超 max_tokens → 截断 → JSON 解析失败 → 静默返回 {}」的老坑。
    # 故 max_tokens 给个稳妥固定值即可（不必再跟存量走）；仍按模型上限兜底。
    _cap = getattr(getattr(settings, "ai", None), "max_tokens", 0) or 4096
    result = await ContextBranch().run(
        BranchInput(stable_system=_load_sys(), delta=user, scope="owner"),
        BranchPolicy(
            name="reflection",
            output_mode="json",
            max_tokens=min(_cap, 900),
            max_retries=0,
        ),
        settings,
    )
    return result.output if result.ok and isinstance(result.output, dict) else {}
