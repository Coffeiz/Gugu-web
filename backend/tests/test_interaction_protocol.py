"""PRD-LLM-2 Phase 1-3 的轻量协议回归。"""

from agent.interactions.events import INTERACTION_REQUIRED, ROUND_START
from agent.interactions.stream_events import decode_event, encode_event
from app.services.interactions import _hash_token


def test_event_identity_survives_round_trip():
    line = encode_event(
        INTERACTION_REQUIRED,
        run_id="run-test",
        round_id="round-2",
        tool_call_id="call-7",
        seq=9,
        prompt_id=12,
    )
    event = decode_event(line)
    assert event is not None
    assert event["run_id"] == "run-test"
    assert event["round_id"] == "round-2"
    assert event["tool_call_id"] == "call-7"
    assert event["seq"] == 9


def test_action_tokens_are_stored_as_one_way_hashes():
    token = "short-lived-action-token"
    assert _hash_token(token) != token
    assert _hash_token(token) == _hash_token(token)


def test_round_event_name_remains_stable():
    assert decode_event(encode_event(ROUND_START, run_id="r", round_id="1", seq=1))["type"] == ROUND_START
