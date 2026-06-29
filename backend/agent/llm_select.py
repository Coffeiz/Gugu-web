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

# 未来 Router 注册口：set_router(fn)，fn(settings, ctx) -> 预设对象 | None
_router = None

_rr_counter = 0                  # round_robin 轮询游标
_inflight: dict[str, int] = {}   # least_loaded 每 key 在途计数（pick 时 +1，release 时 -1）


def _is_mimo(ai) -> bool:
    return (getattr(ai, "provider", "") or "").lower() == "mimo" or "xiaomimimo" in (getattr(ai, "base_url", "") or "").lower()


def use_anthropic_for(ai) -> bool:
    """该模型走 anthropic 块格式还是 openai 格式 —— 全后端唯一判定口（聊天/记忆/IM 共用，避免各处不一致）。
    优先显式 `api_format`（mimo 等同时提供两套 API 的厂商可选）；否则按 provider/base_url 自动判。"""
    fmt = (getattr(ai, "api_format", "") or "").lower()
    if fmt == "anthropic":
        return True
    if fmt == "openai":
        return False
    return (getattr(ai, "provider", "") == "minimax") or ("anthropic" in (getattr(ai, "base_url", "") or "").lower())


def openai_default_headers(ai) -> dict:
    """OpenAI 兼容通道里，部分厂商鉴权头非标准。给它们补对应头，其余空（用 SDK 默认 Authorization: Bearer）。
    - 小米 MiMo：用 `api-key: <KEY>` 头，不是 Bearer。按 provider==mimo / base_url 含 xiaomimimo 识别。"""
    if _is_mimo(ai):
        return {"api-key": getattr(ai, "api_key", "") or ""}
    return {}


def anthropic_default_headers(ai) -> dict:
    """Anthropic 兼容通道的非标准鉴权头。Anthropic SDK 默认发 `x-api-key`；mimo 的 anthropic 端点
    可能要它自己的 `api-key` 头，一并补上（多发一个无害），让 mimo 走 anthropic 格式也能鉴权。"""
    if _is_mimo(ai):
        return {"api-key": getattr(ai, "api_key", "") or ""}
    return {}


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


def vision_model(settings):
    """挑一个支持 vision 的模型配置：顶层 ai（若标了 vision）优先，否则 presets 里 vision=True 的
    （先 in_pool 的、再任意）。都没有 → None。用于「这轮带图但 pick 到的模型看不了图」时强切。"""
    ai = getattr(settings, "ai", None)
    if ai is not None and getattr(ai, "vision", False):
        return ai
    presets = getattr(settings, "ai_presets", None)
    items = list(getattr(presets, "items", None) or []) if presets else []
    vis = [it for it in items if getattr(it, "vision", False)]
    if not vis:
        return None
    pooled = [it for it in vis if getattr(it, "in_pool", False)]
    return (pooled or vis)[0]
