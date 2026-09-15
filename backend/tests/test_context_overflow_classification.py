import pytest

from agent.context.budget import is_context_overflow_error
from app.core.config import AISettings, AIPresetItem


def test_context_overflow_classifier_accepts_input_window_errors():
    errors = [
        ValueError("context_length_exceeded"),
        ValueError("This model's maximum context length is 32768 tokens"),
        ValueError("input token count exceeds the model context window"),
    ]
    structured = ValueError("provider request rejected")
    structured.body = {"error": {"type": "context_length_exceeded", "message": "too long"}}
    errors.append(structured)
    for error in errors:
        assert is_context_overflow_error(error)


@pytest.mark.parametrize(
    "error",
    [
        ValueError("max_tokens exceeds this model's maximum output limit"),
        ValueError("invalid api key"),
        ValueError("HTTP 400 bad request"),
        ValueError("HTTP status 413 in an unrelated proxy diagnostic"),
    ],
)
def test_context_overflow_classifier_rejects_non_input_limit_errors(error):
    assert not is_context_overflow_error(error)


def test_context_overflow_classifier_uses_http_413_status():
    error = ValueError("request failed")
    error.status_code = 413
    assert is_context_overflow_error(error)


@pytest.mark.parametrize(
    "payload",
    [
        {"max_tokens": 0, "context_tokens": 100},
        {"max_tokens": 100, "context_tokens": 100},
        {"max_tokens": 101, "context_tokens": 100},
    ],
)
def test_ai_configuration_rejects_invalid_token_budgets(payload):
    with pytest.raises(ValueError):
        AISettings.model_validate(payload)
    with pytest.raises(ValueError):
        AIPresetItem.model_validate(payload)


def test_ai_configuration_accepts_valid_token_budget():
    assert AISettings.model_validate({"max_tokens": 10, "context_tokens": 100})
    assert AIPresetItem.model_validate({"max_tokens": 10, "context_tokens": 100})
