"""对话后反思：提炼值得长期记住的信息，增量写入 facts/daily。

复用 settings.ai 的 provider 做一次廉价非流式调用，产出 JSON：
  {"facts": ["新长期事实", ...], "daily": "一句话总结(可空)"}
由 web adapter 在对话结束后 fire-and-forget 调用，不阻塞 SSE、失败不影响主流程。
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

from agent.memory import store
from agent.memory._llm import complete_json

# 保持后台任务引用，防止被 GC（fire-and-forget 必须）
_bg_tasks: set = set()

_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"
# 文件缺失时的兜底（正常走 prompts/reflection.md，可热编辑 / Admin 在线改）
_SYS_FALLBACK = (
    "你在帮咕咕维护对用户的长期记忆。只记关于用户本人的稳定信息（身份/偏好/习惯），"
    "不记推测、世界常识、一时状态，不评判用户，宁少勿多、没有就返回空。"
    '严格只输出 JSON：{"facts": ["..."], "daily": "一句话总结(没有就空字符串)"}'
)


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
    try:
        existing = (await store.read_memory(user_id))["facts"]
        out = await _extract(user_name, user_msg, assistant_reply, existing, settings)
        facts = out.get("facts") or []
        daily_note = (out.get("daily") or "").strip()

        # 调和重写：facts 是反思输出的"更新后完整事实集"，覆盖写回。
        new_text = store.format_facts(facts)
        # 防误删兜底：原本有事实、模型却返回空 → 视为异常，保留原文件不覆盖。
        if new_text.strip() or not existing.strip():
            if new_text.strip() != existing.strip():
                await store.write_facts(user_id, new_text)
        if daily_note:
            await store.append_daily(user_id, datetime.now().strftime("%Y-%m-%d"), daily_note)
            # 写完 daily 顺带检查压缩：攒够则把最老的沉淀进 memory.md
            from agent.memory import compress
            await compress.compact(user_id, settings)
    except Exception:
        pass  # 反思是锦上添花，任何失败都不能影响对话


async def _extract(user_name, user_msg, assistant_reply, existing_facts, settings) -> dict:
    user = (
        f"已知的全部事实：\n{existing_facts or '（暂无）'}\n\n"
        f"本次对话：\n用户({user_name})：{user_msg}\n咕咕：{assistant_reply}\n\n"
        f"请输出更新后的完整事实列表（保留仍成立的、修正矛盾、合并重复；没有新信息就原样返回，别清空）。"
    )
    return await complete_json(_load_sys(), user, settings)
