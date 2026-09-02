"""Guard 语言策略的统一注册表。"""

from __future__ import annotations

from dataclasses import dataclass
from re import Pattern


@dataclass(frozen=True)
class GuardLocale:
    narration: Pattern[str]
    action_request: Pattern[str]
    refusal: Pattern[str]
    intent: Pattern[str]
    colon_intent: Pattern[str]
    question: Pattern[str]
    tool_progress_prefixes: tuple[str, ...]
    narration_nudge: str
    intent_nudge: str
    decision_nudge: str
    tool_required_nudge: str


from .guard_locales.en_US import EN_US
from .guard_locales.ja_JP import JA_JP
from .guard_locales.zh_CN import ZH_CN

GUARD_LOCALES = {"zh-CN": ZH_CN, "ja-JP": JA_JP, "en-US": EN_US}


def _locale_key(locale: str | None) -> str:
    normalized = (locale or "zh-CN").replace("_", "-").lower()
    return {"zh-cn": "zh-CN", "ja-jp": "ja-JP", "en-us": "en-US"}.get(normalized, "zh-CN")


def get_guard_locale(locale: str | None = None) -> GuardLocale:
    """按用户语言取得策略；未知语言稳定回退中文。"""
    return GUARD_LOCALES[_locale_key(locale)]
