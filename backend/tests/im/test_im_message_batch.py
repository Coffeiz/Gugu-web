"""IM 防抖批次「一轮一次回复」的回归测试。

用户发一条问题，咕咕回复期间又到了几条消息；这些消息应该攒成**一轮**处理、
最多回一条，而不是每条各起一轮、各回一次（群里表现为咕咕连着刷屏）。
"""
from __future__ import annotations

import asyncio

import pytest


def _key(chat_type: str = "group"):
    from agent.im.session import ImConversationKey

    return ImConversationKey("qq", "bot-1", chat_type, "chat-1")


@pytest.fixture(autouse=True)
def _isolated_worker_state():
    """每个用例独占一份 worker 缓冲状态，避免互相污染。"""
    import worker

    buffers, deadlines, locks, flushes, ingress_locks, buffered, pending = (
        worker._user_buffers,
        worker._user_deadline,
        worker._user_locks,
        worker._user_flush,
        worker._ingress_locks,
        worker._buffered_message_ids,
        worker._pending_message_ids,
    )
    for state in (buffers, deadlines, locks, flushes, ingress_locks, buffered, pending):
        state.clear()
    yield
    for state in (buffers, deadlines, locks, flushes, ingress_locks, buffered, pending):
        state.clear()


@pytest.fixture
def stub_worker_io(monkeypatch):
    """把 handle / register_batch / ack 换成可控的假实现。"""
    import worker

    calls: list[tuple[str, dict]] = []

    async def fake_handle(msg_id, payload):
        calls.append((msg_id, payload))

    async def fake_register_batch(redis, msg_ids):
        return "batch-" + "-".join(msg_ids)

    async def fake_ack(msg_id):
        return None

    monkeypatch.setattr(worker, "handle", fake_handle)
    monkeypatch.setattr("agent.im.inbound_recovery.register_batch", fake_register_batch)
    monkeypatch.setattr(worker, "_ack_inbound", fake_ack)
    return calls


def _im_msg(text: str, speaker: str, chat_type: str = "group") -> dict:
    payload = {
        "platform": "qq",
        "chat_type": chat_type,
        "platform_user_id": speaker,
        "platform_user_name": speaker,
        "text": text,
    }
    if chat_type == "group":
        payload["chat_id"] = "chat-1"
    return payload


def _group_msg(text: str, speaker: str) -> dict:
    return _im_msg(text, speaker)


def test_merge_preserves_an_earlier_direct_mention():
    """先 @ 再补充普通消息，整个批次仍按明确 @ 处理。"""
    from worker import _merge_payloads
    from agent.im.auto_reply import should_enable_group_reply_gate

    first = {**_group_msg("问题", "speaker-a"), "group_mentioned": True, "group_requires_at": False}
    second = {**_group_msg("补充", "speaker-a"), "group_mentioned": False, "group_requires_at": False}
    merged = _merge_payloads([first, second])
    assert merged["group_mentioned"] is True
    assert not should_enable_group_reply_gate(merged)


@pytest.mark.asyncio
async def test_owner_mention_is_a_serial_boundary_between_ordinary_message_runs(monkeypatch):
    """owner @ 单独成轮；前序普通消息不并入 @ run，后续普通消息另行合并。"""
    from agent.im import inbound_batch

    messages = [
        ("100-0", _group_msg("前序消息", "owner")),
        ("101-0", {**_group_msg("@咕咕", "owner"), "bot_mentioned": True}),
        ("102-0", _group_msg("后续补充", "owner")),
        ("103-0", _group_msg("再补充", "owner")),
    ]

    async def owner_mentions(_batch):
        return {1}

    monkeypatch.setattr(inbound_batch, "_owner_mention_indexes", owner_mentions)

    segments = await inbound_batch.partition_inbound_batch(messages)

    assert [[message_id for message_id, _ in segment] for segment in segments] == [
        ["100-0"], ["101-0"], ["102-0", "103-0"],
    ]


def test_merge_keeps_attachment_ids_at_their_original_message_boundary():
    """多人消息合并时仍携带逐条附件 ID，后续可将卡片归回正确发言人。"""
    from worker import _merge_payloads

    first = {
        **_group_msg("A 发图", "speaker-a"),
        "attachments": ["attachment-a"],
        "_early_message_id": 101,
    }
    second = {
        **_group_msg("B 提问", "speaker-b"),
        "attachments": ["attachment-b"],
        "_early_message_id": 102,
    }

    merged = _merge_payloads([first, second])

    assert [item["attachments"] for item in merged["_batch_messages"]] == [
        ["attachment-a"], ["attachment-b"],
    ]


async def test_group_ingress_waits_for_previous_message(monkeypatch):
    """先到消息的早落库尚未结束时，后到消息不能提前进入下一批。"""
    import worker

    first_started = asyncio.Event()
    release_first = asyncio.Event()
    seen = []

    async def dispatch(msg_id, payload):
        seen.append(msg_id)
        if msg_id == "100-0":
            first_started.set()
            await release_first.wait()

    monkeypatch.setattr(worker, "_dispatch", dispatch)
    monkeypatch.setattr(worker, "_ingress_locks", {})
    payload = {**_group_msg("消息", "speaker-a"), "channel_id": "bot-1"}
    first = asyncio.create_task(worker._dispatch_tracked("100-0", payload))
    await first_started.wait()
    second = asyncio.create_task(worker._dispatch_tracked("101-0", payload))
    await asyncio.sleep(0)
    assert seen == ["100-0"]
    release_first.set()
    await asyncio.gather(first, second)
    assert seen == ["100-0", "101-0"]


async def test_private_ingress_waits_for_previous_message(monkeypatch):
    """私聊的异步早落库不能让后到消息越过前一条进入另一批。"""
    import worker

    first_started = asyncio.Event()
    release_first = asyncio.Event()
    seen = []

    async def dispatch(msg_id, payload):
        seen.append(msg_id)
        if msg_id == "100-0":
            first_started.set()
            await release_first.wait()

    monkeypatch.setattr(worker, "_dispatch", dispatch)
    monkeypatch.setattr(worker, "_ingress_locks", {})
    payload = _im_msg("消息", "speaker-a", "c2c")
    payload["channel_id"] = "bot-1"
    first = asyncio.create_task(worker._dispatch_tracked("100-0", payload))
    await first_started.wait()
    second = asyncio.create_task(worker._dispatch_tracked("101-0", payload))
    await asyncio.sleep(0)
    assert seen == ["100-0"]
    release_first.set()
    await asyncio.gather(first, second)
    assert seen == ["100-0", "101-0"]


async def test_slow_early_persistence_cannot_split_and_reverse_group_batch(monkeypatch):
    """第一条入库比防抖窗口慢时，第二条也不能先执行或造成两次回复。"""
    import worker
    from agent.im import early_persist, interaction_text, inbound_recovery

    first_started = asyncio.Event()
    release_first = asyncio.Event()
    delivered = asyncio.Event()
    calls = []

    class Redis:
        async def get(self, _key):
            return None

    async def claim(_message_id):
        return "claimed"

    async def hydrate(payload):
        return payload

    async def no_interaction(**_kwargs):
        return False

    async def persist(_payload, *, message_id):
        if message_id == "100-0":
            first_started.set()
            await release_first.wait()
        return None

    async def register(_redis, _ids):
        return "batch"

    async def handle(_message_id, payload):
        calls.append(payload["text"])
        delivered.set()

    async def ack(_message_id):
        pass

    monkeypatch.setattr(worker, "_claim_message", claim)
    monkeypatch.setattr(worker, "_hydrate_group_policy", hydrate)
    monkeypatch.setattr(worker.R, "get_redis", lambda: Redis())
    monkeypatch.setattr(interaction_text, "has_active_interaction", no_interaction)
    monkeypatch.setattr(early_persist, "persist_early_im_message", persist)
    monkeypatch.setattr(inbound_recovery, "register_batch", register)
    monkeypatch.setattr(worker, "handle", handle)
    monkeypatch.setattr(worker, "_ack_inbound", ack)
    monkeypatch.setattr(worker, "_ingress_locks", {})
    monkeypatch.setattr(worker, "_buffered_message_ids", set())
    monkeypatch.setattr(worker, "_pending_message_ids", set())
    monkeypatch.setattr(worker, "DEBOUNCE_SEC", 0.02)
    base = {**_group_msg("", "speaker-a"), "channel_id": "bot-1", "group_requires_at": False}
    first = asyncio.create_task(worker._dispatch_tracked("100-0", {**base, "text": "A"}))
    await first_started.wait()
    second = asyncio.create_task(worker._dispatch_tracked("101-0", {**base, "text": "B"}))
    await asyncio.sleep(0.05)
    assert calls == []
    release_first.set()
    await asyncio.gather(first, second)
    await asyncio.wait_for(delivered.wait(), 1)
    assert calls == ["A\nB"]
    await asyncio.gather(*list(worker._flush_tasks), return_exceptions=True)


async def test_group_batch_with_two_speakers_answers_once(stub_worker_io):
    """同一批次里的不同发言人消息合并成一轮、只回一次。"""
    import worker

    calls = stub_worker_io
    key = _key()
    worker._user_buffers[key] = [
        ("m1", _group_msg("A", "speaker-a")),
        ("m2", _group_msg("B", "speaker-b")),
    ]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1

    await worker._flush_loop(key)

    assert len(calls) == 1, f"一个批次应该只回一次，实际 {len(calls)} 次"


async def test_messages_arriving_during_a_run_are_answered_together(stub_worker_io):
    """咕咕回复期间到达的消息攒成下一轮，一次性回复。"""
    import worker

    calls = stub_worker_io
    key = _key()
    released = asyncio.Event()

    async def blocking_handle(msg_id, payload):
        calls.append((msg_id, payload))
        if msg_id == "m1":
            await released.wait()

    worker.handle = blocking_handle

    worker._user_buffers[key] = [("m1", _group_msg("A", "speaker-a"))]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1

    flush_task = asyncio.create_task(worker._flush_loop(key))
    # 等第一轮真正开始跑，再模拟「回复期间到达的消息」。
    for _ in range(100):
        if calls:
            break
        await asyncio.sleep(0.01)
    assert calls, "第一轮应该已经开始"

    worker._user_buffers[key] = [
        ("m2", _group_msg("B", "speaker-b")),
        ("m3", _group_msg("C", "speaker-a")),
    ]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1

    released.set()
    await asyncio.wait_for(flush_task, timeout=5)

    assert len(calls) == 2, f"两轮消息应该回两次，实际 {len(calls)} 次"
    assert calls[1][0] == "m3", "第二轮应该带着期间到达的两条消息一起处理"
    assert "B" in calls[1][1]["text"], "第二轮应该包含期间到达的消息正文"
    assert "C" in calls[1][1]["text"], "第二轮应该包含期间到达的消息正文"


async def test_private_messages_arriving_during_a_run_are_answered_together(stub_worker_io):
    """私聊 run 执行期间到达的 B、C 组成下一轮，并保留逐条批次信息。"""
    import worker

    calls = stub_worker_io
    key = _key("c2c")
    released = asyncio.Event()

    async def blocking_handle(msg_id, payload):
        calls.append((msg_id, payload))
        if msg_id == "m1":
            await released.wait()

    worker.handle = blocking_handle
    worker._user_buffers[key] = [("m1", _im_msg("A", "speaker-a", "c2c"))]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1
    flush_task = asyncio.create_task(worker._flush_loop(key))
    for _ in range(100):
        if calls:
            break
        await asyncio.sleep(0.01)
    assert calls

    worker._user_buffers[key] = [
        ("m2", _im_msg("B", "speaker-a", "c2c")),
        ("m3", _im_msg("C", "speaker-a", "c2c")),
    ]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1
    released.set()
    await asyncio.wait_for(flush_task, timeout=5)

    assert len(calls) == 2
    assert calls[1][1]["text"] == "B\nC"
    assert [item["text"] for item in calls[1][1]["_batch_messages"]] == ["B", "C"]
    assert all(item["chat_type"] == "c2c" for item in calls[1][1]["_batch_messages"])


async def test_same_speaker_consecutive_messages_still_merge(stub_worker_io):
    """同一发言人的连续消息仍然合并成一轮（不回归）。"""
    import worker

    calls = stub_worker_io
    key = _key()
    worker._user_buffers[key] = [
        ("m1", _group_msg("A1", "speaker-a")),
        ("m2", _group_msg("A2", "speaker-a")),
    ]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1

    await worker._flush_loop(key)

    assert len(calls) == 1
    assert "A1" in calls[0][1]["text"]
    assert "A2" in calls[0][1]["text"]


async def test_batch_is_merged_in_arrival_order(stub_worker_io):
    """缓冲的 append 顺序乱时，合并后仍按真实到达序（消息 id 单调递增）。

    并发派发下，先到的消息可能后进缓冲；不按到达序重排的话，模型会在一轮里看到
    与群里相反的先后。实测：worker 重启后重投的两条消息就是这样反的。
    """
    import worker

    calls = stub_worker_io
    key = _key()
    worker._user_buffers[key] = [
        ("1730000002000-0", _group_msg("后到的那条", "speaker-a")),
        ("1730000001000-0", _group_msg("先到的那条", "speaker-a")),
    ]
    worker._user_deadline[key] = asyncio.get_event_loop().time() - 1

    await worker._flush_loop(key)

    assert len(calls) == 1
    text = calls[0][1]["text"]
    assert text.index("先到的那条") < text.index("后到的那条"), "合并后应按到达序排列"
    # 路由字段取最后一条 → 回复挂在最新那条消息上。
    assert calls[0][0] == "1730000002000-0"
