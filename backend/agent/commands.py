"""斜杠记忆控制命令（用户在聊天里直接打）——确定性、零 LLM、不计精力、不触发反思。

- `/memory`（/记忆 /记得）  看咕咕目前记得你哪些事（profile + pattern + 最近状态）
- `/forget <内容>`（/忘记 /忘掉）  让咕咕忘掉对得上的那条（profile 或 pattern 都会找）

在 web `stream()` 短路返回（像配额硬拦那样 typed_stream 回一句）；IM 侧在 worker.handle()
消费后、跑 agent 之前同样短路（飞书/QQ/微信用户同享隐私控制权，P0-5）。
`/newchat` 不在此处理：网页已有「新对话」按钮，斜杠新建会话与会话编排耦合，UI 操作即可。
"""
from __future__ import annotations

from agent.memory import store

_PREFIX = ("/", "／")
_MEMORY_NAMES = {"memory", "mem", "记忆", "记得", "你记得什么", "记得啥"}
_FORGET_NAMES = {"forget", "忘记", "忘掉", "忘了"}


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


async def handle(user_id, text: str) -> str | None:
    """命中记忆命令 → 返回回复文本（短路）；否则 None（照常走对话/其它命令）。"""
    name, arg = _parse(text)
    if name is None:
        return None
    if name in _MEMORY_NAMES:
        return await _show_memory(user_id)
    if name in _FORGET_NAMES:
        return await _forget(user_id, arg)
    return None


async def _show_memory(user_id) -> str:
    profile = await store.read_profile_list(user_id)
    facts = await store.read_facts_list(user_id)
    summary = await store.read_summary(user_id)
    if not profile and not facts and not summary:
        return "我现在还没记下关于你的长期信息哦～聊着聊着我会慢慢记住的。"
    lines = ["这是我目前记得的关于你的事："]
    if summary:
        lines.append(f"\n【最近状态】{summary}")
    if profile:
        lines.append("\n【关于你】")
        for p in profile:
            lines.append(f"· {p.get('text', '')}")
    if facts:
        scored = sorted(((f, store._fact_eff(f)) for f in facts),
                        key=lambda x: -(x[1] * (x[0].get("imp", 3) or 3)))
        lines.append("\n【行为习惯】")
        for f, _eff in scored:
            tag = "" if f.get("kind") == "observed" else "（推测）"
            lines.append(f"· {f.get('text', '')}{tag}")
    lines.append("\n想让我忘掉某条，发「/forget 那件事」就行。")
    return "\n".join(lines)


def _forget_match(fact_text: str, arg: str) -> bool:
    """删除匹配：arg(归一≥2字)是 fact 子串，或两者整体相似。比注入匹配宽一点（用户主动点名删）。"""
    na, ng = store._fact_norm(fact_text), store._fact_norm(arg)
    if len(ng) >= 2 and ng in na:
        return True
    return store._fact_similar(fact_text, arg)


async def _forget(user_id, arg: str) -> str:
    if not arg or len(store._fact_norm(arg)) < 2:
        return "想忘掉哪条呀？比如「/forget 我喜欢猫」。发「/memory」可以先看看我都记得啥。"
    profile = await store.read_profile_list(user_id)
    keep_p = [p for p in profile if not _forget_match(p.get("text", ""), arg)]
    facts = await store.read_facts_list(user_id)
    keep_f = [f for f in facts if not _forget_match(f.get("text", ""), arg)]
    removed = (len(profile) - len(keep_p)) + (len(facts) - len(keep_f))
    if removed == 0:
        return f"我记忆里没找到和「{arg}」对得上的事，没动哦。发「/memory」看看现有的。"
    if len(keep_p) != len(profile):
        await store.write_profile_list(user_id, keep_p)
    if len(keep_f) != len(facts):
        await store.write_facts_list(user_id, keep_f)
    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=0, removed=removed, source="forget"))
    return f"好，我把和「{arg}」相关的 {removed} 条记忆忘掉了。"
