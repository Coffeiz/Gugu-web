"""IM 运行时状态机（State Manager）+ 取消标志。

跨进程共享走 Redis：**worker 写状态、网关读状态**。取消是实时控制信号，任务进行中
后续消息排在队列里、worker 可能暂时看不到，所以「算了」必须由**网关**即时写入；
普通 intent shortcut 仍由 worker 的 IM Loop 处理。

key 统一按「会话」隔离（platform:bot_id:scope_id:puid），与活跃集合 agentactive 同作用域：
  agentstate:{platform}:{bot_id}:{scope_id}:{puid}  → 状态字符串（带 TTL，worker 崩了自动过期回 IDLE，防卡死）
  agentcancel:{platform}:{bot_id}:{scope_id}:{puid} → "1"（网关检测到取消意图时置，core 工具循环协作检查后清）

作用域隔离的意义：同一用户在不同群（不同 scope_id）各自独立状态与取消标志，互不串扰——
用户在群 B 发「取消」只取消群 B 自己的 loop，不会误取消群 A 正在跑的任务（P1 跨群取消回归）。
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
    "inspect_images":  SEARCHING,
    "deep_research":   SEARCHING,
    "http_get":        SEARCHING,
    "create_document": GENERATING,
    "send_file":       GENERATING,
}


def _skey(platform, bot_id, scope_id, puid) -> str:
    return f"agentstate:{platform}:{bot_id}:{scope_id}:{puid}"


def _ckey(platform, bot_id, scope_id, puid) -> str:
    return f"agentcancel:{platform}:{bot_id}:{scope_id}:{puid}"


def _norm(v) -> str:
    if not v:
        return IDLE
    return v.decode() if isinstance(v, bytes) else v


# ── 状态：worker 写（async）──────────────────────────────────────────────
async def set_state(platform, bot_id, scope_id, puid, state: str) -> None:
    if platform and bot_id and scope_id and puid:
        await get_redis().set(_skey(platform, bot_id, scope_id, puid), state, ex=STATE_TTL)
        # heartbeat：loop 活跃期间刷新活跃集合 TTL，避免长任务跑超 ACTIVE_TTL 被误判空闲。
        await _refresh_active_ttl(platform, bot_id, scope_id)


async def clear_state(platform, bot_id, scope_id, puid) -> None:
    if platform and bot_id and scope_id and puid:
        await get_redis().delete(_skey(platform, bot_id, scope_id, puid))


async def refresh_activity(platform, bot_id, scope_id, puid) -> None:
    """只刷新忙碌态 TTL，不改变当前状态值。

    长时间的压缩、工具调用或上游等待期间，loop 仍然活着但可能暂时没有调用
    ``set_state``。如果不刷新，网关会把已过期的任务当成空闲，导致 ``/stop``
    不再写取消标志。
    """
    if platform and bot_id and scope_id and puid:
        redis = get_redis()
        await redis.expire(_skey(platform, bot_id, scope_id, puid), STATE_TTL)
        await _refresh_active_ttl(platform, bot_id, scope_id)


# ── 状态：网关读（QQ async / 飞书 sync）─────────────────────────────────
async def get_state(platform, bot_id, scope_id, puid) -> str:
    if not (platform and bot_id and scope_id and puid):
        return IDLE
    return _norm(await get_redis().get(_skey(platform, bot_id, scope_id, puid)))


def get_state_sync(platform, bot_id, scope_id, puid) -> str:
    if not (platform and bot_id and scope_id and puid):
        return IDLE
    return _norm(get_redis_sync().get(_skey(platform, bot_id, scope_id, puid)))


# ── 取消标志：网关置（sync/async）、core 协作检查并清 ────────────────────
async def request_cancel(platform, bot_id, scope_id, puid) -> bool:
    """写取消标志；四个 key 有一个缺失就静默 no-op（返回 False），调用方必须检查
    返回值再决定要不要记"取消已生效"——否则会出现日志说写成功、实际什么都没发生
    的假阳性（code review 发现的真实 bug：fallback 路径漏传 bot_id/scope_id）。"""
    if platform and bot_id and scope_id and puid:
        await get_redis().set(_ckey(platform, bot_id, scope_id, puid), "1", ex=STATE_TTL)
        return True
    return False


def request_cancel_sync(platform, bot_id, scope_id, puid) -> bool:
    if platform and bot_id and scope_id and puid:
        get_redis_sync().set(_ckey(platform, bot_id, scope_id, puid), "1", ex=STATE_TTL)
        return True
    return False


async def is_cancelled(platform, bot_id, scope_id, puid) -> bool:
    if not (platform and bot_id and scope_id and puid):
        return False
    return bool(await get_redis().get(_ckey(platform, bot_id, scope_id, puid)))


async def clear_cancel(platform, bot_id, scope_id, puid) -> None:
    if platform and bot_id and scope_id and puid:
        await get_redis().delete(_ckey(platform, bot_id, scope_id, puid))


# Lua 脚本把「清残留取消标志 + 注册活跃发起者 + 置忙状态」合成一次 Redis 端原子操作。
# KEYS: 1=cancel key, 2=active set key, 3=state key
# ARGV: 1=puid, 2=active_ttl, 3=state, 4=state_ttl
_INIT_ACTIVITY_LUA = """
redis.call('DEL', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
return 1
"""


async def init_activity(platform, bot_id, scope_id, puid, state: str) -> None:
    """原子地完成 clear_cancel + mark_active + set_state，消灭三者之间任何可观察窗口。

    把三步顺序改成 clear_cancel → mark_active → set_state（而不是旧的
    set_state → clear_cancel → mark_active）已经堵住了最糟糕的假成功 ACK：网关
    落地"忙"状态之后才误清用户随后发来的取消标志。但这三步仍是三条独立的 Redis
    命令，之间存在极小窗口——用户如果恰好在 clear_cancel 执行完、set_state(THINKING)
    还没落地之前发"取消"，网关此时读到的 state 依然是上一轮结束后的值（通常是
    IDLE），而网关判断"能不能取消"的依据正是 `state != IDLE`；state 还没变成
    THINKING 就意味着这句"取消"会被当成普通消息排队处理，而不是被识别成取消意图
    （code review 复审指出的残留窗口：不会误清标志，但也没能被识别成取消）。
    用 Lua 脚本把三步在 Redis 端合成单次原子操作，外部永远不会观察到"cancel 已清、
    但 state 还没变成 THINKING"的中间态——state 要么还是上一轮的旧值（这次初始化
    尚未发生），要么已经是 THINKING（三步已经全部完成），二者之间没有可被外部读到
    的过渡态，这条竞态窗口从时间上被彻底消灭，而不是缩短。
    """
    if not (platform and bot_id and scope_id and puid):
        return
    await get_redis().eval(
        _INIT_ACTIVITY_LUA,
        3,
        _ckey(platform, bot_id, scope_id, puid),
        _active_key(platform, bot_id, scope_id),
        _skey(platform, bot_id, scope_id, puid),
        puid,
        ACTIVE_TTL,
        state,
        STATE_TTL,
    )


# ── 活跃 loop 集合：记录「当前正在跑 loop 的发起者 puid」，供网关判断取消权限 ──
#    key 按会话隔离（platform:bot_id:scope_id）：群聊 scope_id=chat_id、私聊 scope_id=sender.id。
#    咕咕并发跑多个 loop 时集合里有多个 puid。用户发「取消」时，网关据此判断：
#    · 当前用户是发起者 → 取消自己的 loop
#    · 当前用户不是发起者（咕咕在忙别人的 loop）→ 提示「无权取消」
#    · 集合为空（咕咕空闲）→ 不触发「无权取消」，走正常逻辑
def _active_key(platform, bot_id, scope_id) -> str:
    return f"agentactive:{platform}:{bot_id}:{scope_id}"


# 活跃集合 TTL：worker 崩溃（kill -9/OOM/断电）时 finally 不执行，SREM 不会发生，
# 集合会残留「幽灵活跃 puid」，导致网关误判「咕咕还在忙」拒绝取消。给集合加 TTL，
# 并在 loop 活跃期间（set_state 频繁调用）刷新，崩溃后自动过期清空。
ACTIVE_TTL = 600   # 10min 兜底


async def _refresh_active_ttl(platform, bot_id, scope_id) -> None:
    """刷新活跃集合 TTL（heartbeat）。loop 正常运行会周期性调用，崩溃后不再刷新而过期。"""
    if platform and bot_id and scope_id:
        await get_redis().expire(_active_key(platform, bot_id, scope_id), ACTIVE_TTL)


async def mark_active(platform, bot_id, scope_id, puid) -> None:
    """loop 启动时记录发起者 puid 到活跃集合，并设置 TTL 兜底。"""
    if platform and bot_id and scope_id and puid:
        key = _active_key(platform, bot_id, scope_id)
        await get_redis().sadd(key, puid)
        await get_redis().expire(key, ACTIVE_TTL)


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
