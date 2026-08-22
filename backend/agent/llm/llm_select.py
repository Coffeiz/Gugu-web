"""模型解析层：统一的「选哪个模型」决策点。

调用层（runner / core）只对接 `pick_model`，未来 Router、多 key 分流都插这里，
core 一行不动。返回的对象带 provider/api_key/base_url/model/max_tokens/temperature/
context_tokens/thinking/vision —— `AIPresetItem` 和 `AISettings` 都满足，调用层统一读。

策略（`ai_presets.strategy`）：
  active 单一激活（默认，= 当前激活预设，行为不变）
  pool   多 key 分流（勾了 in_pool 的预设里随机挑，每 key 一份限流额度）
  router 智能路由（调下方注册的 router；没注册退回 active）—— Router 的插槽
"""
from __future__ import annotations

import random

from agent import providers

# 未来 Router 注册口：set_router(fn)，fn(settings, ctx) -> 预设对象 | None
_router = None

_rr_counter = 0                  # round_robin 轮询游标
_inflight: dict[str, int] = {}   # least_loaded 每 key 在途计数（pick 时 +1，release 时 -1）

# 下面这几个判断函数（PRD-LLM-1 FR-LLM-2）改成委托 agent/providers.py 的
# adapter_for()——provider 差异知识收拢到那一个文件，这里只是保留现有签名/
# 导入路径的薄包装，外部调用点一行不用改。行为跟改动前逐条对齐，见各函数注释。


def _is_mimo(ai) -> bool:
    return providers.adapter_for(ai).name == "mimo"


def _is_deepseek(ai) -> bool:
    return providers.adapter_for(ai).name == "deepseek"


def is_minimax(ai) -> bool:
    """MiniMax 专属流式泄漏清洗的统一判定口。"""
    return providers.adapter_for(ai).name == "minimax"


def supports_anthropic_active_cache(ai) -> bool:
    """当前模型是否支持 Anthropic `cache_control` 主动缓存。

    MiniMax-M2.x/M3 当前均按真机复测结果发送主动缓存标记；MiMo 仍明确不支持该参数。
    """
    return providers.adapter_for(ai).supports_active_cache(getattr(ai, "model", "") or "")


def supports_thinking_toggle(ai) -> bool:
    """该模型(OpenAI 通道)是否支持 `{"thinking":{"type":...}}` 思考开关：mimo 与 deepseek 都用同一参数。
    其它 openai 兼容厂商(qwen/openai)没这参数，传了可能报错，故只对这两家发。"""
    return providers.adapter_for(ai).supports_thinking_toggle


def use_anthropic_for(ai) -> bool:
    """该模型走 anthropic 块格式还是 openai 格式 —— 全后端唯一判定口（聊天/记忆/IM 共用，避免各处不一致）。
    优先显式 `api_format`（mimo 等同时提供两套 API 的厂商可选）；否则按 provider/base_url 自动判。

    这条不能简单委托给 `adapter_for(ai).api_format`——unmatched provider（比如 qwen 等其它
    openai 兼容厂商）在适配器里落到 `_DEFAULT`，但这里的历史默认是「不认识就当 openai 格式，
    除非 base_url 里带 anthropic 字样」，跟 `_DEFAULT` 代表的「真正的 anthropic 原生」语义不是
    一回事，硬delegate 会让不认识的第三方厂商被误判成走 anthropic 格式。所以这条只复用
    `is_minimax`（已经是委托版本），其余判定逻辑原样保留。"""
    return providers.adapter_for(ai).protocol_format(ai) == "anthropic"


def _pick_pool(pool, mode):
    """从分流池按方式挑一个：random 随机 | round_robin 轮询 | least_loaded 最少在途。"""
    if mode == "round_robin":
        global _rr_counter
        p = pool[_rr_counter % len(pool)]
        _rr_counter += 1
        return p
    if mode == "least_loaded":
        p = min(pool, key=lambda it: _inflight.get(it.id, 0))
        _inflight[p.id] = _inflight.get(p.id, 0) + 1   # 标记在途，请求结束须 release
        return p
    return random.choice(pool)


def release(preset) -> None:
    """least_loaded 用：请求结束时减在途计数（调用层 finally 里调）。其他方式 no-op。"""
    pid = getattr(preset, "id", None)
    if pid and _inflight.get(pid):
        _inflight[pid] -= 1


def set_router(fn) -> None:
    global _router
    _router = fn


def pick_model(settings, ctx=None):
    """选一个模型配置返回。无预设 / 默认策略 → 退回顶层 settings.ai（与现状字节级一致）。"""
    presets = getattr(settings, "ai_presets", None)
    items = list(getattr(presets, "items", None) or []) if presets else []
    strategy = getattr(presets, "strategy", "active") if presets else "active"

    if items and strategy != "active":
        if strategy == "router" and _router is not None:
            try:
                picked = _router(settings, ctx)
            except Exception:
                picked = None
            if picked is not None:
                return picked
        elif strategy == "pool":
            pool = [it for it in items if getattr(it, "in_pool", False)]
            if pool:
                return _pick_pool(pool, getattr(presets, "pool_mode", "random"))
    # active（默认）/ 兜底：用顶层 settings.ai（activate 时已把激活预设同步到这里）
    return settings.ai
