from agent.errors import LLMErrorPresentation, describe_llm_error


class _ProviderBusyError(Exception):
    status_code = 529


class _ProviderUnavailableError(Exception):
    status_code = 500


def test_describe_llm_error_keeps_safe_busy_tag_and_retry_count():
    info = describe_llm_error(_ProviderBusyError(), attempts=5)

    assert info.code == "provider_busy"
    assert info.message_key == "chatUi.providerBusyExhausted"
    assert info.message_params == {"tag": "529 _ProviderBusyError", "attempts": 5}
    assert "529 _ProviderBusyError" in info.text
    assert "已自动重试 5 次仍未恢复" in info.text


def test_describe_llm_error_uses_same_provider_text_for_web_and_im():
    info = describe_llm_error(_ProviderUnavailableError())
    event = info.as_event()

    assert event["error_code"] == "provider_unavailable"
    assert event["message"] == event["detail"] == info.text
    assert event["message_key"] == "chatUi.providerUnavailable"
    assert event["message_params"] == {"tag": "500 _ProviderUnavailableError", "attempts": 0}
    assert LLMErrorPresentation.from_event(event) == info


def test_describe_llm_error_classifies_network_failures_without_upstream_tag():
    info = describe_llm_error(TimeoutError("timed out"))

    assert info.code == "network_error"
    assert info.message_key == "chatUi.networkError"
    assert info.message_params == {"tag": "", "attempts": 0}
    assert info.text == "咕咕网络不太好 📡 可以再发一遍吗？"
