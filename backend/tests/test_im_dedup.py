"""IM 入队去重回归测试（P0：防 RESUMED 重连/多进程抢同 message_id 导致双回复）。

R._dedup_check 是 IM 消息入 im:inbound 前的统一去重点：基于 Redis SETNX，
key=im:seen:{platform}:{message_id}，TTL 600s。同 (channel, msg_id) 10 分钟内
重复入队会被丢弃，保证 worker 不会被同一 message 调起两次。

回归保护：
  - 删 feishu 旧进程内 LRU（_seen_message_id + OrderedDict），防止有人想
    「保留 LRU 兜底」时悄悄加回来——双层去重会让 debug 时的现象变成「同 key
    只挡 1 次，挡不到的就透过去」，增加排查成本。
  - 改 produce/produce_sync 返回类型（新增 None），防止调用方依赖「永远
    返回 stream id」而对 None 报错。
  - 改 key 命名（im:seen:{platform}:{message_id}），防止 namespace 改了
    跟老的 im:msgid:* 冲突。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core import redis as R
from app.core.redis import _DEDUP_TTL_SECONDS, _dedup_check


# ── 工具 ──────────────────────────────────────────────────────────
def _redis_with_set_returns(*returns):
    """mock 一个 redis client：set(...) 按顺序返回给定的值。"""
    r = MagicMock()
    r.set = MagicMock(side_effect=list(returns))
    return r


_PAYLOAD_BASE = {"platform": "feishu", "message_id": "evt_abc123"}


# ── _dedup_check 单元测试 ─────────────────────────────────────────

def test_dedup_first_sight_returns_true_and_calls_setnx():
    """第一次见到：返回 True（应当入队），且 SETNX key=im:seen:{ch}:{id} TTL=600s。"""
    r = _redis_with_set_returns(True)   # SETNX=True 表示 key 不存在，刚 set
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check(dict(_PAYLOAD_BASE)) is True
    r.set.assert_called_once_with(
        "im:seen:feishu:evt_abc123", "1", ex=_DEDUP_TTL_SECONDS, nx=True,
    )


def test_dedup_duplicate_returns_false():
    """同一 (platform, message_id) 第二次：SETNX=False（key 已存在）→ return False（不入队）。"""
    r = _redis_with_set_returns(False)
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check({"platform": "qqbot", "message_id": "msg_xyz"}) is False


def test_dedup_namespace_isolates_channels():
    """不同 channel 同 message_id 不应互相冲突（飞书 evt_1 和 QQ evt_1 各是各的）。"""
    feishu = _redis_with_set_returns(True)
    qq = _redis_with_set_returns(True)
    with patch.object(R, "get_redis_sync") as g:
        g.side_effect = [feishu, qq]
        assert _dedup_check({"platform": "feishu", "message_id": "m1"}) is True
        assert _dedup_check({"platform": "qqbot", "message_id": "m1"}) is True
    feishu.set.assert_called_once_with("im:seen:feishu:m1", "1", ex=_DEDUP_TTL_SECONDS, nx=True)
    qq.set.assert_called_once_with("im:seen:qqbot:m1", "1", ex=_DEDUP_TTL_SECONDS, nx=True)


def test_dedup_no_message_id_skips_check():
    """没 message_id 的 payload 不入去重表（放行）——业务自行处理。"""
    r = _redis_with_set_returns()
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check({"platform": "feishu"}) is True        # message_id 缺失
        assert _dedup_check({"message_id": "m1"}) is True          # platform 缺失
        assert _dedup_check({}) is True                             # 都没
    r.set.assert_not_called()


def test_dedup_empty_string_treated_as_missing():
    """空字符串的 platform/message_id 跟缺失一样——避免 'feishu' vs 'feishu ' 误判。"""
    r = _redis_with_set_returns()
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check({"platform": "", "message_id": "m1"}) is True
        assert _dedup_check({"platform": "feishu", "message_id": ""}) is True
        assert _dedup_check({"platform": "feishu", "message_id": "   "}) is True
    r.set.assert_not_called()


def test_dedup_strips_whitespace():
    """platform/message_id 周围的空白被 strip。"""
    r = _redis_with_set_returns(True)
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check({"platform": "  feishu  ", "message_id": "  m1  "}) is True
    r.set.assert_called_once_with("im:seen:feishu:m1", "1", ex=_DEDUP_TTL_SECONDS, nx=True)


def test_dedup_redis_failure_falls_through():
    """Redis 故障时降级为放行（业务优先，宁可重复也别丢消息）+ warning 日志。"""
    r = MagicMock()
    r.set = MagicMock(side_effect=ConnectionError("redis down"))
    with patch.object(R, "get_redis_sync", return_value=r):
        # 不抛异常，返回 True（放行）
        assert _dedup_check(dict(_PAYLOAD_BASE)) is True


def test_dedup_redis_wrong_type_falls_through():
    """Redis 异常路径（除 ConnectionError 外，如 TimeoutError/ResponseError）也降级放行。"""
    import redis as sync_redis
    r = MagicMock()
    r.set = MagicMock(side_effect=sync_redis.TimeoutError("slow"))
    with patch.object(R, "get_redis_sync", return_value=r):
        assert _dedup_check(dict(_PAYLOAD_BASE)) is True


def test_dedup_ttl_is_600_seconds():
    """TTL 必须是 600s（10 分钟）——QQ 协议 resume 窗口是 5min，留余量。改这个值要慎重。"""
    r = _redis_with_set_returns(True)
    with patch.object(R, "get_redis_sync", return_value=r):
        _dedup_check(dict(_PAYLOAD_BASE))
    call = r.set.call_args
    assert call.kwargs.get("ex") == 600 or call.args[-1] == 600, \
        f"TTL 改了，必须验证：当前是 {call.kwargs.get('ex')}"


# ── produce / produce_sync 集成测试 ──────────────────────────────

@pytest.mark.asyncio
async def test_produce_returns_none_on_duplicate():
    """produce 看到 _dedup_check=False 时返回 None，不调 xadd。"""
    r = _redis_with_set_returns(False)
    async_redis = MagicMock()
    async_redis.xadd = AsyncMock(return_value=b"1234-0")
    with patch.object(R, "get_redis_sync", return_value=r), \
         patch.object(R, "get_redis", return_value=async_redis):
        result = await R.produce(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))
        assert result is None
        async_redis.xadd.assert_not_called()


@pytest.mark.asyncio
async def test_produce_xadds_on_first_sight():
    """produce 看到 _dedup_check=True 时正常 xadd，返回 stream id。"""
    r = _redis_with_set_returns(True)
    async_redis = MagicMock()
    async_redis.xadd = AsyncMock(return_value=b"9999-0")
    with patch.object(R, "get_redis_sync", return_value=r), \
         patch.object(R, "get_redis", return_value=async_redis):
        result = await R.produce(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))
        assert result == b"9999-0"
        async_redis.xadd.assert_called_once()
        # payload 序列化进 data 字段
        kwargs = async_redis.xadd.call_args
        assert "data" in kwargs.args[1] or "data" in kwargs.kwargs


def test_produce_sync_returns_none_on_duplicate():
    """produce_sync 看到 _dedup_check=False 时返回 None，不调 xadd。"""
    r = _redis_with_set_returns(False)
    r.xadd = MagicMock(return_value=b"1234-0")
    with patch.object(R, "get_redis_sync", return_value=r):
        result = R.produce_sync(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))
        assert result is None
        r.xadd.assert_not_called()


def test_produce_sync_xadds_on_first_sight():
    """produce_sync 看到 _dedup_check=True 时正常 xadd，返回 stream id。"""
    r = _redis_with_set_returns(True)
    r.xadd = MagicMock(return_value=b"8888-0")
    with patch.object(R, "get_redis_sync", return_value=r):
        result = R.produce_sync(R.IM_INBOUND_STREAM, dict(_PAYLOAD_BASE))
        assert result == b"8888-0"
        r.xadd.assert_called_once()
