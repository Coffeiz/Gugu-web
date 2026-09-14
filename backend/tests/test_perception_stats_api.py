"""感知遥测聚合端点（perception_stats）的直调测试。

用 conftest 的进程内假 Redis 喂 `perc:events` 列表，验证：活跃用户门槛、
misperc 与最近一轮 perc 的配对口径、宏平均、exclude_dev 与时间窗过滤、异常标记。
对应 CRAP-FULL 高危清单：perception_stats（CC=74）。
"""

import json
import time

import pytest

from app.api.v1 import agent_perception as perc_api
from app.core.redis import get_redis


async def _push(*events):
    redis = get_redis()
    for event in events:
        await redis.rpush(perc_api._PERC_KEY, json.dumps(event, ensure_ascii=False))


def _perc(u, ts, intent, *, model="test-model", ambiguity=None, emo=None, emotion=None):
    event = {"t": "perc", "u": u, "ts": ts, "intent": intent, "model": model}
    if ambiguity is not None:
        event["ambiguity"] = ambiguity
    if emo is not None:
        event["emo"] = emo
    if emotion:
        event["emotion"] = emotion
    return event


async def test_perception_stats_empty_returns_note(db):
    payload = await perc_api.perception_stats(db=db)
    assert payload["active_users"] == 0
    assert payload["perc_total"] == 0
    assert "暂无活跃用户" in payload["note"]


async def test_perception_stats_pairs_misperc_to_latest_perc(db):
    now = time.time()
    u = "aaaaaaaa"
    await _push(
        _perc(u, now - 300, "查询", ambiguity=20, emo=2),
        {"t": "misperc", "u": u, "ts": now - 200, "kind": "感知误读"},
        _perc(u, now - 100, "闲聊", ambiguity=40, emo=1, emotion="委屈"),
        {"t": "fb", "u": u, "ts": now - 50, "v": "有用"},
    )

    payload = await perc_api.perception_stats(db=db)

    assert payload["active_users"] == 1
    assert payload["perc_total"] == 2
    assert payload["misperc_total"] == 1
    assert payload["overall_misperc_rate"] == 0.5
    assert payload["perception_misperc_rate"] == 0.5
    # misperc 配对到它之前最近一轮 perc 的 intent/model
    by_intent = {row["intent"]: row for row in payload["intent_distribution"]}
    assert by_intent["查询"]["misperc"] == 1
    # 池化误判率 = 该 intent 的纠正数 / 该 intent 的 perc 数（1/1）
    assert by_intent["查询"]["misperc_rate"] == 1.0
    assert by_intent["闲聊"]["misperc"] == 0
    assert payload["misperc_by_kind"] == [{"kind": "感知误读", "count": 1}]
    assert payload["avg_ambiguity"] == 30
    assert payload["avg_emo_strength"] == 1.5
    assert payload["emotion_distribution"] == [{"emotion": "委屈", "count": 1}]
    assert payload["feedback_total"] == 1
    assert payload["feedback_distribution"] == [{"feedback": "有用", "count": 1}]
    # 样本量小（<min_n 默认 10），不该乱标红
    assert payload["flags"] == []


async def test_perception_stats_min_events_gate_excludes_noise_users(db):
    now = time.time()
    await _push(_perc("one-shot", now, "查询"))

    payload = await perc_api.perception_stats(db=db, min_events=2)
    assert payload["active_users"] == 0
    assert "暂无活跃用户" in payload["note"]

    still_visible = await perc_api.perception_stats(db=db, min_events=1)
    assert still_visible["active_users"] == 1


async def test_perception_stats_hours_window_filters_old_events(db):
    now = time.time()
    await _push(
        _perc("bbbbbbbb", now - 10 * 3600, "查询"),   # 窗口外
        _perc("bbbbbbbb", now - 60, "闲聊"),
    )

    payload = await perc_api.perception_stats(db=db, hours=1)
    assert payload["perc_total"] == 1
    by_intent = {row["intent"]: row for row in payload["intent_distribution"]}
    assert by_intent["闲聊"]["count"] == 1
    assert by_intent.get("查询") is None


async def test_perception_stats_exclude_dev_filters_developer_prefix(db, user_a, monkeypatch):
    now = time.time()
    user_a.is_developer = True
    db.add(user_a)
    await db.commit()
    dev_prefix = str(user_a.id)[:8]
    await _push(
        _perc(dev_prefix, now, "查询"),
        _perc("cccccccc", now, "闲聊"),
    )

    included = await perc_api.perception_stats(db=db, exclude_dev=False)
    assert included["active_users"] == 2

    excluded = await perc_api.perception_stats(db=db, exclude_dev=True)
    assert excluded["active_users"] == 1
    assert {row["intent"] for row in excluded["intent_distribution"]} == {"闲聊"}


async def test_perception_stats_flags_high_misperc_intent(db):
    now = time.time()
    u = "dddddddd"
    # 同一 intent 10 轮里 6 轮被纠正 → 误判率 0.6 > rate_hi 0.25，且 n=10 ≥ min_n
    events = []
    for index in range(10):
        events.append(_perc(u, now - 1000 + index, "查询"))
        if index % 2 == 0 and index < 6 * 2:
            events.append({"t": "misperc", "u": u, "ts": now - 1000 + index + 0.5, "kind": "数据或执行错"})
    await _push(*events)

    payload = await perc_api.perception_stats(db=db, min_n=10)
    kinds = {flag for flag in payload["flags"] if "误判率偏高" in flag}
    assert kinds
    assert payload["flag_items"][0]["kind"] == "intent"
    assert payload["flag_items"][0]["intent"] == "查询"
