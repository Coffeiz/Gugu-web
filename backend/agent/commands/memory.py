"""/memory 与 /forget 命令。"""
from __future__ import annotations

from agent.commands.help import command_help, is_help_arg
from agent.memory import store


async def show_memory(user_id, arg: str = "", locale: str | None = None) -> str:
    if is_help_arg(arg):
        return command_help("memory", locale)
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
        for item in profile:
            lines.append(f"· {item.get('text', '')}")
    if patterns:
        scored = sorted(((item, store._pattern_eff(item)) for item in patterns),
                        key=lambda x: -(x[1] * (x[0].get("imp", 3) or 3)))
        lines.append("\n【行为习惯】")
        for item, _eff in scored:
            tag = "" if item.get("kind") == "observed" else "（推测）"
            lines.append(f"· {item.get('text', '')}{tag}")
    lines.append("\n想让我忘掉某条，发「/forget 那件事」就行。")
    return "\n".join(lines)


def _forget_match(pattern_text: str, arg: str) -> bool:
    na, ng = store._pattern_norm(pattern_text), store._pattern_norm(arg)
    if len(ng) >= 2 and ng in na:
        return True
    return store._pattern_similar(pattern_text, arg)


async def forget(user_id, arg: str, locale: str | None = None) -> str:
    if is_help_arg(arg):
        return command_help("forget", locale)
    if not arg or len(store._pattern_norm(arg)) < 2:
        return "想忘掉哪条呀？比如「/forget 我喜欢猫」。发「/memory」可以先看看我都记得啥。"
    profile = await store.read_profile_list(user_id)
    keep_profile = [item for item in profile if not _forget_match(item.get("text", ""), arg)]
    patterns = await store.read_pattern_list(user_id)
    keep_patterns = [item for item in patterns if not _forget_match(item.get("text", ""), arg)]
    removed = (len(profile) - len(keep_profile)) + (len(patterns) - len(keep_patterns))
    if removed == 0:
        return f"我记忆里没找到和「{arg}」对得上的事，没动哦。发「/memory」看看现有的。"
    if len(keep_profile) != len(profile):
        await store.write_profile_list(user_id, keep_profile)
    if len(keep_patterns) != len(patterns):
        await store.write_pattern_list(user_id, keep_patterns)
    from agent import events
    events.publish(events.types.MemoryUpdated(user_id=user_id, added=0, removed=removed, source="forget"))
    return f"好，我把和「{arg}」相关的 {removed} 条记忆忘掉了。"
