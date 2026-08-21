"""斜杠控制命令（用户在聊天里直接打）——确定性、不计精力、不触发反思。

- `/memory`（/记忆 /记得）  看咕咕目前记得你哪些事（profile + pattern + 最近状态）
- `/forget <内容>`（/忘记 /忘掉）  让咕咕忘掉对得上的那条（profile 或 pattern 都会找）
- `/compact`（/压缩）  立即压缩当前会话的旧历史

在 web `stream()` 短路返回（像配额硬拦那样 typed_stream 回一句）；IM 侧在 worker.handle()
消费后、跑 agent 之前同样短路（飞书/QQ/微信用户同享隐私控制权，P0-5）。
`/newchat` 不在此处理：网页已有「新对话」按钮，斜杠新建会话与会话编排耦合，UI 操作即可。
"""
from __future__ import annotations

import logging

from agent.memory import store

logger = logging.getLogger(__name__)

_PREFIX = ("/", "／")
_MEMORY_NAMES = {"memory", "mem", "记忆", "记得", "你记得什么", "记得啥"}
_FORGET_NAMES = {"forget", "忘记", "忘掉", "忘了"}
_COMPACT_NAMES = {"compact", "压缩", "整理上下文"}


def _parse(text: str):
    """拆 `/cmd 参数`（半/全角斜杠与空格都认）。非斜杠 → (None, None)。"""
    t = (text or "").strip()
    if t[:1] not in _PREFIX:
        return None, None
    body = t[1:].strip()
    for sep in (" ", "　"):
        if sep in body:
            name, arg = body.split(sep, 1)
            return name.strip().lower(), arg.strip()
    return body.strip().lower(), ""


async def handle(user_id, text: str, *, session_id: int | None = None) -> str | None:
    """命中控制命令 → 返回回复文本（短路）；否则 None。"""
    name, arg = _parse(text)
    if name is None:
        return None
    if name in _MEMORY_NAMES:
        return await _show_memory(user_id)
    if name in _FORGET_NAMES:
        return await _forget(user_id, arg)
    if name in _COMPACT_NAMES:
        return await _compact(user_id, session_id)
    return None


async def _compact(user_id, session_id: int | None) -> str:
    """压缩当前会话；不创建新会话，也不把命令交给主模型。"""
    if not session_id:
        return "当前还没有可压缩的对话。"
    from app.core.config import get_settings
    from agent.context import compress_conv

    settings = get_settings()
    try:
        compacted = await compress_conv.compress_if_needed(
            session_id,
            user_id,
            settings,
            settings.ai.context_tokens,
        )
    except Exception:
        logger.exception("手动压缩会话失败 session=%s", session_id)
        return "这次压缩没有完成，请稍后再试。"
    if compacted:
        return "上下文已经整理好了，旧对话已压缩为摘要。"
    return "当前上下文还没达到压缩条件，暂时不用整理。"


async def _show_memory(user_id) -> str:
    profile = await store.read_profile_list(user_id)
    patterns = await store.read_pattern_list(user_id)
    summary = await store.read_summary(user_id)
    if not profile and not patterns and not summary:
        return "我现在还没记下关于你的长期信息哦～聊着聊着我会慢慢记住的。"
    lines = ["这是我目前记得的关于你的事："]
    if summary:
        lines.append(f"\n【最近状态】{summary}")
    if profile:
        lines.append("\n【关于你】")
        for p in profile:
            lines.append(f"· {p.get('text', '')}")
    if patterns:
        scored = sorted(((item, store._pattern_eff(item)) for item in patterns),
                        key=lambda x: -(x[1] * (x[0].get("imp", 3) or 3)))
        lines.append("\n【行为习惯】")
        for f, _eff in scored:
            tag = "" if f.get("kind") == "observed" else "（推测）"
            lines.append(f"· {f.get('text', '')}{tag}")
    lines.append("\n想让我忘掉某条，发「/forget 那件事」就行。")
    return "\n".join(lines)


def _forget_match(pattern_text: str, arg: str) -> bool:
    """删除匹配：arg(归一≥2字)是 pattern 子串，或两者整体相似。"""
    na, ng = store._pattern_norm(pattern_text), store._pattern_norm(arg)
    if len(ng) >= 2 and ng in na:
        return True
    return store._pattern_similar(pattern_text, arg)


async def _forget(user_id, arg: str) -> str:
    if not arg or len(store._pattern_norm(arg)) < 2:
        return "想忘掉哪条呀？比如「/forget 我喜欢猫」。发「/memory」可以先看看我都记得啥。"
    profile = await store.read_profile_list(user_id)
    keep_p = [p for p in profile if not _forget_match(p.get("text", ""), arg)]
    patterns = await store.read_pattern_list(user_id)
    kept_patterns = [item for item in patterns if not _forget_match(item.get("text", ""), arg)]
    removed = (len(profile) - len(keep_p)) + (len(patterns) - len(kept_patterns))
    if removed == 0:
        return f"我记忆里没找到和「{arg}」对得上的事，没动哦。发「/memory」看看现有的。"
    if len(keep_p) != len(profile):
        await store.write_profile_list(user_id, keep_p)
    if len(kept_patterns) != len(patterns):
        await store.write_pattern_list(user_id, kept_patterns)
    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=0, removed=removed, source="forget"))
    return f"好，我把和「{arg}」相关的 {removed} 条记忆忘掉了。"
