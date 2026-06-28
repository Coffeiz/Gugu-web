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
    "不记推测、世界常识、一时状态，不评判用户，宁少勿多、没有就返回空。summary 是一句"
    "「用户当下在忙什么/近期重心」的快照，基于原快照演进、没变就原样返回。perception 是本轮观察"
    "（intent/ambiguity/emotion/emo_strength），照实判、只打点。"
    '严格只输出 JSON：{"facts": ["..."], "daily": "一句话总结(没有就空字符串)", "summary": "当前状态快照(没有就空字符串)", '
    '"perception": {"intent": "情绪/查询/执行/...", "ambiguity": 0, "emotion": "无", "emo_strength": 0}}'
)

# 误判捕获:用户这句像在纠正上一条回复没领会对 = 唯一干净的客观真值（高精度词，宁缺勿滥）
_CORRECTION_MARKERS = ("不是我", "我是说", "我的意思是", "你理解错", "理解错了", "我要的是",
                       "搞错了", "你弄错", "不是这个", "我说的是", "不对，", "不对,", "不是，", "不是,")
_PERC_INTENTS = {"执行", "推进", "记录", "查询", "决策", "反思", "情绪", "陪伴", "闲聊"}


_PERC_KEY = "perc:events"    # Redis capped list:给 Admin 聚合面板（/admin/perception）读
_PERC_CAP = 20000


def _now_ts() -> float:
    import time
    return time.time()   # 真 epoch 浮点（保留亚秒序，误判配对才不乱；别用 utcnow().timestamp() 跨时区会偏）


def _misperc_rec(user_id, user_msg: str) -> dict | None:
    """这句像纠正上一条 → 一条 misperc 记录（离线按 user 相邻配前一条 perc = 被误判那轮）。"""
    head = (user_msg or "").strip()[:16]
    hit = next((m for m in _CORRECTION_MARKERS if m in head), None)
    if not hit:
        return None
    return {"t": "misperc", "u": str(user_id)[:8], "marker": hit, "ts": _now_ts()}


def _perc_rec(user_id, perc, model: str) -> dict | None:
    """本轮观察 → 一条 perc 记录（只结构化字段，不写用户原文）。"""
    if not isinstance(perc, dict):
        return None
    intent = perc.get("intent")
    return {"t": "perc", "u": str(user_id)[:8], "model": model or "",
            "intent": intent if intent in _PERC_INTENTS else "其他",
            "ambiguity": perc.get("ambiguity"), "emotion": perc.get("emotion"),
            "emo": perc.get("emo_strength"), "ts": _now_ts()}


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


def schedule(user_id, user_name, user_msg, assistant_reply, settings) -> None:
    """非阻塞触发一次反思。琐碎应答（嗯/好的/谢谢…）直接跳过，省调用。"""
    if not _worth_reflecting(user_msg):
        return
    task = asyncio.create_task(
        reflect(user_id, user_name, user_msg, assistant_reply, settings)
    )
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def reflect(user_id, user_name, user_msg, assistant_reply, settings) -> None:
    # 误判捕获:纯正则、零依赖，先于 LLM 调用打点（即使下面 extract 失败也已记下）
    await _emit_perc(_misperc_rec(user_id, user_msg))
    try:
        mem = await store.read_memory(user_id)
        existing = mem["facts"]
        existing_summary = mem.get("summary", "")
        out = await _extract(user_name, user_msg, assistant_reply, existing, existing_summary, settings)
        # 感知遥测:把本轮 perception 打日志 + 推 Redis（不写记忆）
        await _emit_perc(_perc_rec(user_id, out.get("perception"), getattr(getattr(settings, "ai", None), "model", "")))
        facts = out.get("facts") or []
        daily_note = (out.get("daily") or "").strip()
        summary = (out.get("summary") or "").strip()

        # 调和重写：facts 是反思输出的"更新后完整事实集"，覆盖写回。
        new_text = store.format_facts(facts)
        # 防误删兜底：原本有事实、模型却返回空 → 视为异常，保留原文件不覆盖。
        if new_text.strip() or not existing.strip():
            if new_text.strip() != existing.strip():
                await store.write_facts(user_id, new_text)
        # summary 同理：非空才覆盖、变了才写（防把已有快照清空/瞎改）
        if summary and summary != existing_summary.strip():
            await store.write_summary(user_id, summary)
        if daily_note:
            await store.append_daily(user_id, datetime.now().strftime("%Y-%m-%d"), daily_note)
            # 写完 daily 顺带检查压缩：攒够则把最老的沉淀进 memory.md
            from agent.memory import compress
            await compress.compact(user_id, settings)
    except Exception:
        pass  # 反思是锦上添花，任何失败都不能影响对话


async def _extract(user_name, user_msg, assistant_reply, existing_facts, existing_summary, settings) -> dict:
    user = (
        f"已知的全部事实：\n{existing_facts or '（暂无）'}\n\n"
        f"当前状态快照：\n{existing_summary or '（暂无）'}\n\n"
        f"本次对话：\n用户({user_name})：{user_msg}\n咕咕：{assistant_reply}\n\n"
        f"请输出更新后的完整事实列表 + 当前状态快照 + 本轮 perception（保留仍成立的、修正矛盾、合并重复；"
        f"快照基于原快照演进、没变就原样返回；都别清空。perception 照本轮用户消息判，始终给）。"
    )
    return await complete_json(_load_sys(), user, settings)
