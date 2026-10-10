import json

import pytest

from agent.core import LLMRunner


def _event(event_type: str, **payload) -> str:
    return "data: " + json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n\n"


@pytest.mark.asyncio
async def test_runner_continuation_recovery_reuses_committed_messages_once():
    runner = LLMRunner([], type("Settings", (), {"ai": object()})())
    calls = []

    def provider(*args, **kwargs):
        messages_arg = args[2]
        calls.append(messages_arg)
        call_number = len(calls)

        async def stream():
            if call_number == 1:
                # 模拟工具结果已提交、续轮事件已发出，但 provider 生成器提前结束。
                yield _event("_new_round", next_round=2)
                return
            yield _event("round_start", round_id="round-2")
            yield _event("token", content="工具结果已处理")

        return stream()

    runner._run_provider = provider
    messages = [{"role": "user", "content": "测试"}]
    events = [event async for event in runner.run(
        "user-1", "system", messages, use_anthropic=False,
        model_cfg=object(), session_id=1,
    )]

    assert len(calls) == 2
    assert calls[0] is messages
    assert calls[1] is messages
    assert any(json.loads(event[6:])["type"] == "round_start" for event in events)
    assert any(json.loads(event[6:]).get("content") == "工具结果已处理" for event in events)


@pytest.mark.asyncio
async def test_runner_continuation_recovery_emits_error_after_one_retry():
    runner = LLMRunner([], type("Settings", (), {"ai": object()})())

    def provider(*args, **kwargs):
        async def stream():
            yield _event("_new_round", next_round=2)

        return stream()

    runner._run_provider = provider

    events = [
        event
        async for event in runner.run(
            "user-1", "system", [], use_anthropic=False,
            model_cfg=object(), session_id=1,
        )
    ]

    errors = [json.loads(event[6:]) for event in events if json.loads(event[6:])["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["detail"] == "工具结果已返回，但后续回复没有完成，请重试。"
