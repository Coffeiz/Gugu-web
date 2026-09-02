"""Agent Loop 守卫编排。

判定流程保持在这里，语言相关规则统一由 ``guard_locales`` 注册表提供。
"""

import re

from agent.security.guard_patterns import GuardLocale, ZH_CN, get_guard_locale

# 兼容旧的内部导入与测试：默认策略仍为简体中文。
_NARRATION_NUDGE = ZH_CN.narration_nudge
_DECISION_NUDGE = ZH_CN.decision_nudge
_INTENT_NUDGE = ZH_CN.intent_nudge
_TOOL_REQUIRED_NUDGE = ZH_CN.tool_required_nudge
_TOOL_PROGRESS_PREFIXES = ZH_CN.tool_progress_prefixes


def _looks_like_narration(text: str, locale: str | None = None) -> bool:
    return bool(text) and bool(get_guard_locale(locale).narration.search(text))


def _is_decision_dodge(user_req: str, reply: str, locale: str | None = None) -> bool:
    policy = get_guard_locale(locale)
    return bool(user_req and reply) and bool(policy.action_request.search(user_req)) and bool(policy.refusal.search(reply))


def _announces_intent(text: str, locale: str | None = None) -> bool:
    """判断模型是否宣告将执行动作，却没有实际调用工具。"""
    if not text:
        return False
    policy = get_guard_locale(locale)
    if policy.question.search(text):
        return False
    return bool(policy.intent.search(text)) or bool(policy.colon_intent.search(text.strip()))


def _guard_text(text: str) -> str:
    """去掉进度话术中的空白和句末标点，便于判断是否为纯占位输出。"""
    return re.sub(r"[\s\u3000，。！？、:：….!?]+", "", text or "")


def _could_be_tool_progress(text: str, locale: str | None = None) -> bool:
    normalized = _guard_text(text)
    prefixes = get_guard_locale(locale).tool_progress_prefixes
    return bool(normalized) and any(_guard_text(prefix).startswith(normalized) for prefix in prefixes)


def _is_tool_progress_only(text: str, locale: str | None = None) -> bool:
    normalized = _guard_text(text)
    prefixes = get_guard_locale(locale).tool_progress_prefixes
    return bool(normalized) and normalized in {_guard_text(prefix) for prefix in prefixes}


def guard_locale(locale: str | None = None) -> GuardLocale:
    """公开统一入口，供 Loop 和其他运行模式取得同一份策略。"""
    return get_guard_locale(locale)
