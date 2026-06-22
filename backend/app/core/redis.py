"""共享 Redis 异步客户端 + Streams 队列封装。

懒加载单例（同 db.session 的 engine 模式）：首次用时按 settings.redis 建连接，
Admin 改配置后 reset() 重建。Streams 作 IM 消息队列：网关 produce 入队、worker
consume 消费、处理完 ack；claim_stale 回收崩溃 worker 的未确认消息。

消息体统一以单字段 data=JSON 存放，produce/consume 自动序列化/反序列化。
"""
from __future__ import annotations

import json
from typing import Optional

import redis.asyncio as aioredis

from app.core.config import get_settings

# IM 消息入站队列（网关 produce、worker consume 共用）
IM_INBOUND_STREAM = "im:inbound"

_client: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        cfg = get_settings().redis
        _client = aioredis.from_url(
            cfg.url,
            decode_responses=True,
            socket_connect_timeout=6,
            socket_keepalive=True,
            socket_timeout=None,  # 阻塞读（XREADGROUP block）不能有读超时，否则到点抛 TimeoutError
        )
    return _client


async def reset() -> None:
    """配置变更后重建连接（同 db.reset_engine）。"""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
        _client = None


async def ping() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception:
        return False


# ── Streams 封装 ──────────────────────────────────────────────────────────────

async def ensure_group(stream: str, group: str) -> None:
    """创建消费组（若不存在）；id=0 + mkstream：流不存在也能建，且不漏掉建组前已入队的消息。"""
    try:
        await get_redis().xgroup_create(stream, group, id="0", mkstream=True)
    except aioredis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


async def produce(stream: str, payload: dict, maxlen: int = 10000) -> str:
    """入队一条（payload 存为单字段 data=JSON）。approximate maxlen 防流无界增长。"""
    return await get_redis().xadd(
        stream, {"data": json.dumps(payload, ensure_ascii=False)},
        maxlen=maxlen, approximate=True,
    )


def _parse(entries) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for msg_id, fields in entries:
        raw = fields.get("data")
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {"_raw": raw}
        out.append((msg_id, payload))
    return out


async def consume(stream: str, group: str, consumer: str,
                  count: int = 1, block_ms: int = 5000) -> list[tuple[str, dict]]:
    """阻塞消费新消息（消费组语义）。返回 [(msg_id, payload), ...]，无则空列表。"""
    resp = await get_redis().xreadgroup(
        group, consumer, {stream: ">"}, count=count, block=block_ms,
    )
    out: list[tuple[str, dict]] = []
    if resp:
        for _stream, entries in resp:
            out.extend(_parse(entries))
    return out


async def ack(stream: str, group: str, msg_id: str) -> None:
    await get_redis().xack(stream, group, msg_id)


# ── 同步 produce（给平台网关用：lark/botpy 的 start() 是同步阻塞 loop，handler 同步）──
_sync_client = None


def get_redis_sync():
    import redis as _redis_sync
    global _sync_client
    if _sync_client is None:
        cfg = get_settings().redis
        _sync_client = _redis_sync.from_url(cfg.url, decode_responses=True, socket_connect_timeout=6)
    return _sync_client


def produce_sync(stream: str, payload: dict, maxlen: int = 10000) -> str:
    return get_redis_sync().xadd(
        stream, {"data": json.dumps(payload, ensure_ascii=False)},
        maxlen=maxlen, approximate=True,
    )


async def claim_stale(stream: str, group: str, consumer: str,
                      min_idle_ms: int = 60000, count: int = 10) -> list[tuple[str, dict]]:
    """回收待处理超过 min_idle 的消息（崩溃 worker 的遗留），认领给当前 consumer。"""
    try:
        resp = await get_redis().xautoclaim(
            stream, group, consumer, min_idle_time=min_idle_ms,
            start_id="0-0", count=count,
        )
    except aioredis.ResponseError:
        return []
    # redis-py 返回 (next_cursor, entries[, deleted_ids])
    entries = resp[1] if len(resp) > 1 else []
    return _parse(entries)
