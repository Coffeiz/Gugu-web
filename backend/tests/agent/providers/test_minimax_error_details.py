"""MiniMax 错误详情：2013 区分「上下文超限」与「通用参数错误」。

上游把「输入上下文超限」也归到 2013 这类通用参数错误码里，只有文案带真实语义。
这里锁定两件事：命中超限文案时给出上下文超限的文案与 i18n key；其它 2013 仍然
是通用参数错误，不能被误判成超限。
"""

from agent.providers.minimax import minimax_error_details


class _MiniMaxBadRequest(Exception):
    """模拟 Anthropic 端点返回的 400 响应体。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code
        self.body = {
            "error": {"type": "invalid_request_error", "message": message},
            "base_resp": {"status_code": 2013},
            "request_id": "req-2013-001",
        }


def test_context_overflow_message_gets_dedicated_summary_and_key():
    details = minimax_error_details(
        _MiniMaxBadRequest("invalid params, context window exceeds limit (2013)")
    )

    assert details is not None
    assert details.code == "2013"
    assert details.context_overflow is True
    assert details.description_key == "chatUi.minimaxErrorCodes.contextOverflow"
    assert "上下文窗口" in details.summary


def test_other_2013_parameter_errors_keep_generic_summary():
    details = minimax_error_details(
        _MiniMaxBadRequest("invalid params, thinking requires adaptive thinking (2013)")
    )

    assert details is not None
    assert details.code == "2013"
    assert details.context_overflow is False
    assert details.description_key == "chatUi.minimaxErrorCodes.code2013"
    assert details.summary == "请求参数错误，请检查模型、接口格式和请求参数"


def test_request_size_errors_are_not_reported_as_context_overflow():
    """413 体量语义不是上下文窗口超限，不能对用户说「上下文超限」。

    判定走不走压缩兜底仍由更宽的清单决定（见上下文分类测试），但用户看到的
    定性必须指向真实原因，否则会把用户引到「缩短上下文」这个无效方向。
    """
    details = minimax_error_details(
        _MiniMaxBadRequest("request entity too large (2013)")
    )

    assert details is not None
    assert details.code == "2013"
    assert details.context_overflow is False
    assert details.description_key == "chatUi.minimaxErrorCodes.code2013"
    assert details.summary == "请求参数错误，请检查模型、接口格式和请求参数"


def test_non_minimax_error_is_not_classified():
    assert minimax_error_details(ValueError("本地组装失败")) is None
