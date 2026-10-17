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


def test_describe_llm_error_classifies_remote_protocol_error_and_records_context(monkeypatch):
    import agent.errors as errors

    class RemoteProtocolError(Exception):
        pass

    captured = []
    monkeypatch.setattr(errors, "diag_log", lambda where, error: captured.append((where, error)))
    error = RemoteProtocolError("synthetic stream closed")
    info = describe_llm_error(error, diagnostic_context="agent.llm.call run_id=run-test budget=10")

    assert info.code == "network_error"
    assert len(captured) == 1 and captured[0][1] is error
    assert "agent.llm.call" in captured[0][0]
    assert "budget=10" in captured[0][0]


def test_responses_failed_event_has_same_safe_error_for_web_and_im(monkeypatch):
    """Responses 上游失败与内部异常分开，包装后仍保留跨渠道一致分类。"""
    import agent.errors as errors
    from agent.providers.errors import ResponsesStreamError

    captured = []
    monkeypatch.setattr(errors, "diag_log", lambda where, error: captured.append((where, error)))
    provider_error = ResponsesStreamError('合成诊断 network_error 私有内容')
    wrapped = RuntimeError("调用失败")
    wrapped.__cause__ = provider_error
    info = describe_llm_error(wrapped)

    assert info.code == "provider_stream_error"
    assert info.message_key == "chatUi.providerStreamError"
    assert set(info.message_params) == {"diagnostic_id"}
    assert LLMErrorPresentation.from_event(info.as_event()) == info
    assert "network_error" not in str(info.as_event())
    assert "私有内容" not in str(info.as_event())
    assert captured[0][1] is wrapped
    assert describe_llm_error(RuntimeError("Responses API returned a failed response")).code == "internal_error"
