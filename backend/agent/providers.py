"""Provider 适配层：每个 LLM 供应商一份适配器，封装「怎么跟它打交道」的差异点
（走哪种 API 格式 / 缓存能力 / 鉴权头 / 流式重试白名单）。

跟 `agent/llm_select.py` 是两层不同的关注点——`llm_select` 决定「选哪个模型」
（pool/router/active 策略），这里决定「选定后该怎么跟它对话」。`llm_select.py`
现有的 provider 判断函数（`is_minimax`/`_is_mimo`/`_is_deepseek`/
`supports_anthropic_active_cache`/`supports_thinking_toggle`/
`openai_default_headers`/`anthropic_default_headers`）改成委托本模块的
`adapter_for()`，签名和导入路径不变（PRD-LLM-1 FR-LLM-2）。

新增/修改 provider 差异点只改这一个文件，不用再去 8 个调用点里挨个找。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass(frozen=True)
class ProviderAdapter:
    name: str
    api_format: str                                   # "anthropic" | "openai"
    supports_active_cache: Callable[[str], bool]       # (model_name) -> bool
    supports_thinking_toggle: bool
    auth_headers: Callable[[object], dict]             # (ai) -> 额外鉴权头
    # 这个 provider 的流式调用里，额外算「瞬时可重试」的异常类型（在 core.py 的
    # 基础 anthropic.*Error 之外追加）。默认空——只有已知会有怪癖的 provider 才加。
    transient_exceptions: tuple = field(default_factory=tuple)


_DEFAULT = ProviderAdapter(
    name="anthropic",
    api_format="anthropic",
    supports_active_cache=lambda model: True,
    supports_thinking_toggle=False,
    auth_headers=lambda ai: {},
)

_MINIMAX = ProviderAdapter(
    name="minimax",
    api_format="anthropic",
    # MiniMax-M3 只支持被动前缀缓存，不应发送 cache_control；官方主动缓存文档目前
    # 仅列 MiniMax-M2.x（迁自原 supports_anthropic_active_cache 的判定）。
    supports_active_cache=lambda model: (model or "").lower().startswith("minimax-m2"),
    supports_thinking_toggle=False,
    auth_headers=lambda ai: {},
    # IndexError/KeyError：MiniMax 偶发返回空/异常的流式响应，anthropic SDK 解析时越界
    # （原有白名单，见 core.py _stream_round 里的注释）。
    # AttributeError：SDK 内部 accumulate_event() 遇到 usage=None 的事件时未判空崩溃
    # （2026-07-14 QQ「重写 PRD README/INDEX」故障根因，见 PRD-LLM-1）。
    # 只对 MiniMax 生效，不放宽其它 provider——AttributeError 是最泛的异常类型之一，
    # 全局放宽会把跟 MiniMax 无关的真实 bug 也一并当"重试就好"吞掉。
    transient_exceptions=(IndexError, KeyError, AttributeError),
)

_MIMO = ProviderAdapter(
    name="mimo",
    api_format="openai",
    supports_active_cache=lambda model: False,
    supports_thinking_toggle=True,
    # 小米 MiMo：用 `api-key` 头，不是 Bearer（迁自原 openai_default_headers/anthropic_default_headers）。
    auth_headers=lambda ai: {"api-key": getattr(ai, "api_key", "") or ""},
)

_DEEPSEEK = ProviderAdapter(
    name="deepseek",
    api_format="openai",
    supports_active_cache=lambda model: True,
    supports_thinking_toggle=True,
    auth_headers=lambda ai: {},
)

_REGISTRY: dict[str, ProviderAdapter] = {
    "minimax": _MINIMAX,
    "mimo": _MIMO,
    "deepseek": _DEEPSEEK,
}


def adapter_for(ai) -> ProviderAdapter:
    """按 `ai.provider` 精确匹配；未命中时按 `ai.base_url` 关键字兜底——
    兜底口径跟原 `_is_mimo`/`_is_deepseek` 保持一致，不改变现有识别行为。
    都没命中 → 退回 anthropic 原生 default 适配器（`transient_exceptions` 为空，
    不会有任何 provider 专属的异常容忍）。"""
    provider = (getattr(ai, "provider", "") or "").lower()
    if provider in _REGISTRY:
        return _REGISTRY[provider]
    base_url = (getattr(ai, "base_url", "") or "").lower()
    if "xiaomimimo" in base_url:
        return _MIMO
    if "deepseek" in base_url:
        return _DEEPSEEK
    return _DEFAULT
