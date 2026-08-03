"""Per-user typing_ticket 缓存（仿 OpenClaw `api/config-cache.ts`）。

iLink 的 `typing_ticket` 是 **per-user 的**（每个微信用户独立一份 base64 串，
有效期 24h），调用方 `send_typing` 必须带对应用户的 ticket 才有效。如果每条
消息都先 getconfig 拿 ticket，多了一层 HTTP 调用且浪费接口配额——按用户缓存
更合算。

## 缓存策略（与 OpenClaw 一致）
- **首次 fetch**：收到该用户第一条消息时同步调 getconfig
- **TTL 24h**：在 (0.5 × TTL, 1.0 × TTL) 区间**随机**选下一次刷新时刻 → 多实例 /
  多 bot 不会同时打刷新接口
- **失败退避**：2s → 4s → ... → 1h 指数退避（最长 1h），`ever_succeeded=False` 的
  初始 entry 也走 INITIAL_RETRY_MS（避免一条坏请求卡住后续所有消息）
- **失败时退化**：返回空 ticket，调用方按"没 ticket 不发 typing"分支走——**不挡主流程**

## 进程模型
Gugu-web 的微信网关是**单进程服务多 user**（一个 bot 一个网关进程，对应多个
微信用户），所以 `WeixinConfigManager` 是网关进程内**模块级单例**——天然就是
per-user 缓存，不需要跨进程共享。

worker 进程**不直接用这个 cache**：worker 只通过 payload 里的 `typing_ticket`
字段拿 ticket 发 typing。如果未来要做"worker 也能拿 ticket"（比如长任务 worker
也得 keepalive），再加一个 Redis 共享层即可。
"""
from __future__ import annotations

import asyncio
import random
import time
from typing import Any, Callable

from agent.gateway.wechat_client import ILinkClient

# 与 OpenClaw config-cache.ts 常量一致
CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000           # 24h 上限
CONFIG_CACHE_INITIAL_RETRY_MS = 2_000               # 失败初始退避 2s
CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1000          # 失败最大退避 1h

LogFn = Callable[[str], None]


def _now_ms() -> float:
    return time.time() * 1000


class WeixinConfigManager:
    """Per-user `typing_ticket` 缓存 + 指数退避重试。

    用法（wechat.py 网关）：

        mgr = WeixinConfigManager({"bot_token": ..., "base_url": ...}, log=print)
        cfg = await mgr.get_for_user(from_user_id, context_token)
        if cfg["typing_ticket"]:
            ... # 写入 payload['typing_ticket']，worker 用它发 typing
    """

    def __init__(self, api_opts: dict, log: LogFn | None = None):
        # api_opts = {"bot_token": str, "base_url": str}——worker 不缓存，所以只网关用
        self._api_opts = dict(api_opts)
        self._log = log or (lambda msg: None)
        self._cache: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        # 复用同一 httpx client（同进程多 user 减少建连开销）
        self._client: ILinkClient | None = None

    async def _get_client(self) -> ILinkClient:
        if self._client is None:
            cli = ILinkClient(
                bot_token=self._api_opts.get("bot_token", ""),
                base_url=self._api_opts.get("base_url", ""),
            )
            await cli.start()
            self._client = cli
        return self._client

    async def close(self) -> None:
        """网关退出时调，关闭复用的 httpx client。"""
        if self._client is not None:
            await self._client.stop()
            self._client = None

    async def get_for_user(self, user_id: str, context_token: str = "") -> dict[str, Any]:
        """拿该用户的 typing_ticket（带缓存）。失败时仍返回 dict，但 ticket 为空。"""
        async with self._lock:
            now = _now_ms()
            entry = self._cache.get(user_id)
            # 缓存命中且未到期 → 直接返回
            if entry is not None and now < entry["next_fetch_at"]:
                return entry

            should_fetch = entry is None or now >= entry["next_fetch_at"]
            if not should_fetch:
                return entry  # type: ignore[return-value]

            # 该刷了：调 getconfig
            fetch_ok = False
            try:
                cli = await self._get_client()
                resp = await cli.get_config(user_id, context_token)
                if resp.get("ret") in (0, None):
                    ticket = resp.get("typing_ticket") or ""
                    # 随机化下次刷新时刻：[0.5*TTL, 1.0*TTL]——避免多实例/多 bot
                    # 同时到点刷新打爆接口
                    next_at = now + CONFIG_CACHE_TTL_MS * (0.5 + 0.5 * random.random())
                    self._cache[user_id] = {
                        "typing_ticket": ticket,
                        "next_fetch_at": next_at,
                        "retry_delay_ms": CONFIG_CACHE_INITIAL_RETRY_MS,
                        "ever_succeeded": True,
                    }
                    self._log(
                        f"[weixin-config] typing_ticket "
                        f"{'refreshed' if entry and entry.get('ever_succeeded') else 'cached'} "
                        f"for {user_id} (len={len(ticket)})"
                    )
                    fetch_ok = True
                else:
                    self._log(f"[weixin-config] getConfig ret={resp.get('ret')} errmsg={resp.get('errmsg')}")
            except Exception as e:
                self._log(f"[weixin-config] getConfig failed for {user_id} (ignored): {type(e).__name__}: {e}")

            if not fetch_ok:
                # 失败退避：指数 backoff，最大 1h
                prev_delay = entry["retry_delay_ms"] if entry else CONFIG_CACHE_INITIAL_RETRY_MS
                next_delay = min(prev_delay * 2, CONFIG_CACHE_MAX_RETRY_MS)
                if entry is not None:
                    entry["next_fetch_at"] = now + next_delay
                    entry["retry_delay_ms"] = next_delay
                else:
                    self._cache[user_id] = {
                        "typing_ticket": "",
                        "next_fetch_at": now + CONFIG_CACHE_INITIAL_RETRY_MS,
                        "retry_delay_ms": CONFIG_CACHE_INITIAL_RETRY_MS,
                        "ever_succeeded": False,
                    }
                # 即使失败也返回 entry（typing_ticket 为空），让调用方按"空 ticket"分支走
                # ——typing 是锦上添花，不能拖累主流程

            return self._cache[user_id]