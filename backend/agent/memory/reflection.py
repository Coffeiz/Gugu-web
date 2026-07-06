"""对话后反思：提炼值得长期记住的信息，增量写入 facts/daily。

复用 settings.ai 的 provider 做一次廉价非流式调用，产出 JSON：
  {"facts": [...], "daily": "...", "summary": "...", "perception": {intent/ambiguity/emotion/emo_strength}}
facts=稳定事实、daily=本次流水、summary=「用户当下在忙什么」快照（增量演进）。
perception=本轮观察（感知遥测，只打点 `agent.perc` 日志，不写记忆、不影响回复）。
由 web/IM 在对话结束后 fire-and-forget 调用，不阻塞、失败不影响主流程。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from agent.memory import store
from agent.memory._llm import complete_json

# 保持后台任务引用，防止被 GC（fire-and-forget 必须）
_bg_tasks: set = set()

# 感知遥测/误判 日志（与 agent.traj 同套：靠 logging 配置落 gugu.log / Debug 面板；脱敏，不写用户原文）
_perc_log = logging.getLogger("agent.perc")

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
# 文件缺失时的兜底（正常走 prompts/reflection.md，可热编辑 / Admin 在线改）
_SYS_FALLBACK = (
    "你在帮咕咕维护对用户的长期记忆。只记关于用户本人的稳定信息（身份/偏好/习惯），"
    "不记推测、世界常识、一时状态，不评判用户，宁少勿多。**只报本轮的增删**：新值得长期记的"
    "进 facts_add（每条对象 {text, kind: observed=亲述/inferred=推断, importance: 1-5}）；"
    "被推翻/过时/被替换的旧条进 facts_remove（字符串、尽量照抄原文）；没变动就都给空数组、别重列旧事实。"
    "summary 是一句「用户当下在忙什么/近期重心」的快照，基于原快照演进、没变就原样返回；"
    "涉及具体时间点一律换算成绝对日期（如「7/6 晚」而非「今晚」），照 user 消息开头给的当前日期换算。"
    "perception 是本轮观察（intent/ambiguity/emotion/emo_strength），照实判、只打点。"
    "correction 唯一判 true 的条件：错的主体是**你（咕咕）本人这次的回答/理解**（用户说「你错了/不是这个/我说的是…」）。"
    "错的若是**别人**一律 false：用户认自己错/确认你是对的（是我错了/你是对的/哦原来如此）、说第三方或外部信息错"
    "（他记错了/这数据源不对/官网写错了）、单纯聊「某事是错的」——都 false（句里有「错」字也不算）。"
    "kind 仅 true 时给——`感知误读`(没读懂用户要什么) / `数据或执行错`(读懂了但数据/操作做错)，拿不准偏后者。"
    "lens_hint：仅当本轮**确实暴露了一条「怎么读懂这个用户」的可复用规则**才写、绝大多数轮留空字符串"
    "（一次性误会、具体事实都不算）。固定格式『「触发语」→ 真实含义/应对』，触发语放「」里写关键几字"
    "（如『「随便」→ 其实有偏好要追问』），便于复现识别。"
    '严格只输出 JSON：{"facts_add": [{"text": "...", "kind": "observed", "importance": 4}], "facts_remove": ["..."], '
    '"daily": "一句话总结(没有就空字符串)", "summary": "当前状态快照(没有就空字符串)", "lens_hint": "", '
    '"correction": {"is_correction": false, "kind": ""}, '
    '"perception": {"intent": "情绪/查询/执行/...", "ambiguity": 0, "emotion": "无", "emo_strength": 0}}'
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


_PERC_KEY = "perc:events"    # Redis capped list:给 Admin 聚合面板（/admin/perception）读
_PERC_CAP = 20000
_MISREAD_KEY = "perc:misread_cases"   # 错读需求案例收集（带脱敏 miss 诊断，便于翻「具体原因」）
_MISREAD_CAP = 500


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


def schedule(user_id, user_name, user_msg, assistant_reply, settings, used_tools=None, session_id=None) -> None:
    """非阻塞触发一次反思。琐碎应答（嗯/好的/谢谢…）默认跳过省调用——
    但若这轮咕咕**用了工具**（如「要建项目吗？」→「嗯」→真建了），即便用户只说「嗯」也反思，
    以记下这轮做了啥（daily/summary）。used_tools 传列表(web)或 bool(IM 代理)皆可，truthy 即视为有动作。
    session_id 供 feedback 判「是否延续同一对话」（换会话不跨比，见 _read_last_turn）。"""
    if not _worth_reflecting(user_msg) and not used_tools:
        return
    task = asyncio.create_task(
        reflect(user_id, user_name, user_msg, assistant_reply, settings, session_id=session_id)
    )
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def reflect(user_id, user_name, user_msg, assistant_reply, settings, session_id=None) -> None:
    out = None
    prev_turn = await _read_last_turn(user_id, session_id)   # 上一轮（判 feedback），换会话/过期 → None
    try:
        mem = await store.read_memory(user_id)
        existing_summary = mem.get("summary", "")
        out = await _extract(user_name, user_msg, assistant_reply, mem["facts"], existing_summary, settings,
                             prev_turn=prev_turn)
    except Exception:
        out = None
    # 无论 extract 成败，都把本轮存为「上一轮」缓存（带 session_id，下轮据此判是否延续）
    await _write_last_turn(user_id, user_msg, assistant_reply, session_id)

    # 误判捕获:优先信反思 LLM 判的 correction（能分「感知误读 vs 数据/执行错」，正则做不到）；
    # extract 没成（{} / 异常）才退回正则兜底（高精度、漏召回）。二选一，不重复计。
    if isinstance(out, dict) and out:
        await _emit_perc(_misperc_llm(user_id, out.get("correction")))
    else:
        await _emit_perc(_misperc_regex(user_id, user_msg))
        return  # extract 没结果，facts/summary 无从写

    try:
        # 感知遥测:把本轮 perception 打日志 + 推 Redis（不写记忆）
        await _emit_perc(_perc_rec(user_id, out.get("perception"), getattr(getattr(settings, "ai", None), "model", "")))
        # 反馈信号（feedback 枚举,白名单校验）:学习闭环的燃料,只打点（见 proposals/反馈信号系统-设计.md）
        await _emit_perc(_fb_rec(user_id, out.get("feedback")))
        # 行为模块选择：把本轮 stance（= perception.intent）落 per-user，供下一轮 builder 点亮模块（带新鲜度闸）
        await store.write_stance(user_id, (out.get("perception") or {}).get("intent"))
        daily_note = (out.get("daily") or "").strip()
        summary = (out.get("summary") or "").strip()

        # facts 更新（2b 结构化）：反思只吐增删 facts_add(带 kind/importance)/facts_remove，
        # apply_facts_ops 应用到 facts.json（命中相似条→印证升 conf，否则新增）。输出不随 facts 增长。
        f_add, f_rem = out.get("facts_add"), out.get("facts_remove")
        legacy = out.get("facts")   # 旧 prompt 回显整份 facts（灰度兼容）→ 当 inferred 增量并入
        if f_add is not None or f_rem is not None or legacy:
            cur = await store.read_facts_list(user_id)
            adds = f_add if f_add is not None else (legacy or [])
            new = store.apply_facts_ops(cur, adds, f_rem or [])
            if new != cur:
                await store.write_facts_list(user_id, new)
                await store.sync_fact_vecs(user_id, new)   # 增量补向量缓存（embedding 未启用=no-op）
                from agent import events
                events.publish(events.types.MemoryUpdated(
                    user_id=user_id, added=len(adds or []), removed=len(f_rem or []), source="reflection"))
        # summary 同理：非空才覆盖、变了才写（防把已有快照清空/瞎改）
        if summary and summary != existing_summary.strip():
            await store.write_summary(user_id, summary)
        if daily_note:
            await store.append_daily(user_id, datetime.now().strftime("%Y-%m-%d"), daily_note)
            # 写完 daily 顺带检查压缩：攒够则把最老的沉淀进 memory.md
            from agent.memory import compress
            await compress.compact(user_id, settings)
        # lens（解读先验）gated 学习：hint 多数轮为空；候选须复现才提拔成规则。顺带做退休维护。
        from agent.memory import lens
        await lens.observe(user_id, out.get("lens_hint"))
        # 关系温度：超 24h 旧才重算（窗口聚合、纯数据侧、自带 DB 会话,见 memory/temperature.py）
        from agent.memory import temperature
        await temperature.maybe_refresh(user_id)
    except Exception:
        pass  # 反思是锦上添花，任何失败都不能影响对话


async def _extract(user_name, user_msg, assistant_reply, existing_facts, existing_summary, settings,
                   prev_turn: dict | None = None) -> dict:
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
        f"已知的全部事实：\n{existing_facts or '（暂无）'}\n\n"
        f"当前状态快照：\n{existing_summary or '（暂无）'}\n\n"
        f"{prev_part}"
        f"本次对话：\n用户({user_name})：{user_msg}\n咕咕：{assistant_reply}\n\n"
        f"请只报本轮 facts 的增删（facts_add / facts_remove，没变动就都给空数组、别重列旧事实）"
        f"+ 当前状态快照（基于原快照演进、没变就原样返回、别清空）+ 本轮 perception（照本轮用户消息判、始终给）"
        f"+ feedback（用户这句相对【上一轮】的反馈,枚举选一,没给上一轮就 无信号）。"
    )
    # 2b：反思只吐 facts 的增删（delta）+ daily/summary/perception，输出体量**不再随 facts 增长**，
    # 根治了「facts 一多 → 回显整份超 max_tokens → 截断 → JSON 解析失败 → 静默返回 {}」的老坑。
    # 故 max_tokens 给个稳妥固定值即可（不必再跟 facts 量走）；仍按模型上限兜底。
    _cap = getattr(getattr(settings, "ai", None), "max_tokens", 0) or 4096
    return await complete_json(_load_sys(), user, settings, max_tokens=min(_cap, 900))
