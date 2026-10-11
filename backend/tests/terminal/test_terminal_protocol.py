import pytest

from agent.terminal.protocol import PtyClientMessage, PtyServerMessage


def test_pty_client_protocol_validates_input_resize_and_signal():
    assert PtyClientMessage.from_dict({"type": "input", "data": "ls\n"}).data == "ls\n"
    assert PtyClientMessage.from_dict({"type": "resize", "cols": 120, "rows": 32}).cols == 120
    assert PtyClientMessage.from_dict({"type": "signal", "signal": "SIGINT"}).signal == "SIGINT"
    assert PtyClientMessage.from_dict({"type": "detach"}).type == "detach"


@pytest.mark.parametrize(
    "message",
    [
        {"type": "unknown"},
        {"type": "input", "data": ""},
        {"type": "resize", "cols": 1, "rows": 32},
        {"type": "resize", "cols": 120, "rows": 300},
        {"type": "signal", "signal": "SIGKILL"},
    ],
)
def test_pty_client_protocol_rejects_unsafe_or_invalid_messages(message):
    with pytest.raises(ValueError):
        PtyClientMessage.from_dict(message)


def test_pty_output_message_does_not_allow_empty_chunks():
    with pytest.raises(ValueError):
        PtyServerMessage.output("")


def test_non_object_client_message_is_rejected():
    with pytest.raises(ValueError, match="必须是对象"):
        PtyClientMessage.from_dict([])
