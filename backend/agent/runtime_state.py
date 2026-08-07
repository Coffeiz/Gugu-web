"""IM 运行时状态机（State Manager）+ 取消标志。

跨进程共享走 Redis：**worker 写状态、网关读状态**。取消是实时控制信号，任务进行中
后续消息排在队列里、worker 可能暂时看不到，所以「算了」必须由**网关**即时写入；
普通 intent shortcut 仍由 worker 的 IM Loop 处理。

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


# ── 活跃 loop 集合：记录「当前正在跑 loop 的发起者 puid」，供网关判断取消权限 ──
#    key 按会话隔离（platform:bot_id:scope_id）：群聊 scope_id=chat_id、私聊 scope_id=sender.id。
#    咕咕并发跑多个 loop 时集合里有多个 puid。用户发「取消」时，网关据此判断：
#    · 当前用户是发起者 → 取消自己的 loop
#    · 当前用户不是发起者（咕咕在忙别人的 loop）→ 提示「无权取消」
#    · 集合为空（咕咕空闲）→ 不触发「无权取消」，走正常逻辑
def _active_key(platform, bot_id, scope_id) -> str:
    return f"agentactive:{platform}:{bot_id}:{scope_id}"


async def mark_active(platform, bot_id, scope_id, puid) -> None:
    """loop 启动时记录发起者 puid 到活跃集合。"""
    if platform and bot_id and scope_id and puid:
        await get_redis().sadd(_active_key(platform, bot_id, scope_id), puid)


async def unmark_active(platform, bot_id, scope_id, puid) -> None:
    """loop 结束时从活跃集合移除发起者 puid。"""
    if platform and bot_id and scope_id and puid:
        await get_redis().srem(_active_key(platform, bot_id, scope_id), puid)


async def get_active(platform, bot_id, scope_id) -> set:
    """返回当前活跃 loop 的发起者 puid 集合（空集合 = 咕咕空闲）。"""
    if not (platform and bot_id and scope_id):
        return set()
    return set(await get_redis().smembers(_active_key(platform, bot_id, scope_id)))


def get_active_sync(platform, bot_id, scope_id) -> set:
    """同步版 get_active（飞书网关用）。"""
    if not (platform and bot_id and scope_id):
        return set()
    return set(get_redis_sync().smembers(_active_key(platform, bot_id, scope_id)))


# ── 等回话标志：咕咕回复以提问/确认收尾时 worker 置；网关读到 → 让「嗯/好/算了」放行进 agent ──
#    （否则确认被当闲聊 drop/秒回吞掉，主模型永远收不到。20min 窗口，超时自动失效）
AWAIT_TTL = 1200


def _akey(platform, puid) -> str:
    return f"agentawait:{platform}:{puid}"


async def set_awaiting(platform, puid, val: bool) -> None:
    """咕咕回复定稿后 worker 调：以提问收尾→置标志，否则清掉。"""
    if not (platform and puid):
        return
    if val:
        await get_redis().set(_akey(platform, puid), "1", ex=AWAIT_TTL)
    else:
        await get_redis().delete(_akey(platform, puid))


async def is_awaiting(platform, puid) -> bool:
    if not (platform and puid):
        return False
    return bool(await get_redis().get(_akey(platform, puid)))


def is_awaiting_sync(platform, puid) -> bool:
    if not (platform and puid):
        return False
    return bool(get_redis_sync().get(_akey(platform, puid)))
