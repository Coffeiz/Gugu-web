"""IM 运行时状态机（State Manager）+ 取消标志。

跨进程共享走 Redis：**worker 写状态、网关读状态**。IM 是单 worker 顺序消费队列——
任务进行中后续消息排在队列里、worker 在忙看不到，所以「还在吗 / 算了」必须由**网关**
据此状态短路（见 `agent/router.py`），不能进 worker。

key（按平台用户隔离）：
  agentstate:{platform}:{puid}  → 状态字符串（带 TTL，worker 崩了自动过期回 IDLE，防卡死）
  agentcancel:{platform}:{puid} → "1"（网关检测到取消意图时置，core 工具循环协作检查后清）
"""
from app.core.redis import get_redis, get_redis_sync

IDLE            = "idle"
THINKING        = "thinking"
SEARCHING       = "searching"
GENERATING      = "generating"
WAITING_CONFIRM = "waiting_confirm"

STATE_TTL = 300   # 5min 兜底：worker 崩了 / 漏清，状态自动过期回 IDLE

# 工具名 → 进入的细粒度状态（其余工具维持 THINKING）
TOOL_STATE = {
    "web_search":      SEARCHING,
    "deep_research":   SEARCHING,
    "http_get":        SEARCHING,
    "create_document": GENERATING,
    "send_file":       GENERATING,
}


def _skey(platform, puid) -> str:
    return f"agentstate:{platform}:{puid}"


def _ckey(platform, puid) -> str:
    return f"agentcancel:{platform}:{puid}"


def _norm(v) -> str:
    if not v:
        return IDLE
    return v.decode() if isinstance(v, bytes) else v


# ── 状态：worker 写（async）──────────────────────────────────────────────
async def set_state(platform, puid, state: str) -> None:
    if platform and puid:
        await get_redis().set(_skey(platform, puid), state, ex=STATE_TTL)


async def clear_state(platform, puid) -> None:
    if platform and puid:
        await get_redis().delete(_skey(platform, puid))


# ── 状态：网关读（QQ async / 飞书 sync）─────────────────────────────────
async def get_state(platform, puid) -> str:
    if not platform or not puid:
        return IDLE
    return _norm(await get_redis().get(_skey(platform, puid)))


def get_state_sync(platform, puid) -> str:
    if not platform or not puid:
        return IDLE
    return _norm(get_redis_sync().get(_skey(platform, puid)))


# ── 取消标志：网关置（sync/async）、core 协作检查并清 ────────────────────
async def request_cancel(platform, puid) -> None:
    if platform and puid:
        await get_redis().set(_ckey(platform, puid), "1", ex=STATE_TTL)


def request_cancel_sync(platform, puid) -> None:
    if platform and puid:
        get_redis_sync().set(_ckey(platform, puid), "1", ex=STATE_TTL)


async def is_cancelled(platform, puid) -> bool:
    if not platform or not puid:
        return False
    return bool(await get_redis().get(_ckey(platform, puid)))


async def clear_cancel(platform, puid) -> None:
    if platform and puid:
        await get_redis().delete(_ckey(platform, puid))
