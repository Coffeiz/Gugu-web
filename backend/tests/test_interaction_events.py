import json

from agent.interactions.events import ROUND_START, TOOL_CALL_START
from agent.interactions.stream_events import decode_event, encode_event


def test_stream_event_round_trip_preserves_payload():
    line = encode_event(
        ROUND_START,
        run_id="run-test",
        round_id="round-1",
        seq=1,
    )

    assert decode_event(line) == {
        "type": ROUND_START,
        "run_id": "run-test",
        "round_id": "round-1",
        "seq": 1,
    }


def test_stream_event_supports_structured_tool_input():
    line = encode_event(
        TOOL_CALL_START,
        run_id="run-test",
        round_id="round-1",
        tool_call_id="tool-1",
        input={"query": "测试"},
    )

    assert json.loads(line[6:])[
        "input"
    ] == {"query": "测试"}
    assert decode_event("not-an-event") is None
