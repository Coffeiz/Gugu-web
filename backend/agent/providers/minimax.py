import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from .base import MediaLimits, ProviderAdapter, ProviderCapabilities, ReasoningCapabilities


_ERROR_MESSAGES = {
    "1000": "未知或系统默认错误，请稍后再试",
    "1001": "请求超时，请稍后再试",
    "1002": "请求频率超限，请稍后再试",
    "1004": "未授权或 API Key 与账户不匹配，请检查 API Key",
    "1008": "账户余额不足，请检查账户余额",
    "1024": "MiniMax 内部错误，请稍后再试",
    "1026": "输入内容触发敏感内容检查，请调整输入内容",
    "1027": "输出内容触发敏感内容检查，请调整输入内容",
    "1033": "下游服务错误，请稍后再试",
    "1039": "请求超过 Token 限制，请调整 max_tokens 或缩短上下文",
    "1041": "连接数达到限制，请稍后再试或联系 MiniMax 支持",
    "1042": "输入包含过多不可见或非法字符，请检查输入内容",
    "1043": "ASR 相似度检查失败，请检查音频与校验文本",
    "1044": "语音克隆提示词与音频相似度检查失败",
    "2013": "请求参数错误，请检查模型、接口格式和请求参数",
    "20132": "语音克隆样本或 voice_id 参数错误",
    "2037": "语音克隆样本时长不符合要求",
    "2038": "语音克隆功能未启用，需完成账户认证",
    "2039": "voice_id 已存在，请修改后重试",
    "2042": "当前账户无权访问该 voice_id",
    "2045": "请求频率增长过快，请避免请求量骤增骤减",
    "2048": "语音克隆提示音频过长",
    "2049": "API Key 无效，请检查 API Key",
    "2056": "已达到 M Plan 资源限制，请等待资源恢复后重试",
}

_HTTP_ERROR_MESSAGES = {
    "400": "请求参数不合法，例如音频时长超过接口限制",
    "401": "API Key 缺失或无效",
    "402": "账户余额或资源包不足",
    "413": "请求体超过 50 MB 限制",
    "422": "音频内容触发敏感内容检查",
    "429": "请求触发限流，请稍后重试",
    "500": "MiniMax 服务端错误，请稍后重试",
}


@dataclass(frozen=True)
class MiniMaxErrorDetails:
    code: str
    error_type: str
    request_id: str
    summary: str
    description_key: str


def minimax_error_details(error: BaseException) -> MiniMaxErrorDetails | None:
    """解析 MiniMax HTTP 错误；原始响应正文不返回给调用方。"""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        response = getattr(current, "response", None)
        request = getattr(response, "request", None)
        hostname = (urlsplit(str(getattr(request, "url", "") or "")).hostname or "").lower()
        body = getattr(current, "body", None)
        if not isinstance(body, dict) and response is not None:
            try:
                body = response.json()
            except Exception:
                body = None
        if not isinstance(body, dict):
            body = {}

        error_body = body.get("error")
        base_resp = body.get("base_resp")
        raw_error_type = str(error_body.get("type") or "") if isinstance(error_body, dict) else ""
        error_type = re.sub(r"[^A-Za-z0-9_.-]", "", raw_error_type)[:80] or "-"
        is_minimax_host = (
            hostname == "minimax.cn"
            or hostname.endswith(".minimax.cn")
            or hostname == "minimaxi.com"
            or hostname.endswith(".minimaxi.com")
        )
        if not is_minimax_host and not isinstance(base_resp, dict):
            current = current.__cause__ or current.__context__
            continue

        candidates = []
        if isinstance(error_body, dict):
            candidates.extend((error_body.get("code"), error_body.get("error_code")))
        if isinstance(base_resp, dict):
            candidates.append(base_resp.get("status_code"))
        candidates.extend((body.get("error_code"), body.get("code")))

        message_candidates = []
        if isinstance(error_body, dict):
            message_candidates.extend((error_body.get("message"), error_body.get("status_msg")))
        if isinstance(base_resp, dict):
            message_candidates.append(base_resp.get("status_msg"))
        message_candidates.append(body.get("message"))
        for message in message_candidates:
            if isinstance(message, str):
                match = re.search(r"\((\d{3,5})\)\s*$", message)
                if match:
                    candidates.append(match.group(1))

        code = next((str(item) for item in candidates
                     if isinstance(item, (int, str)) and re.fullmatch(r"\d{3,5}", str(item))), "")
        status_code = getattr(current, "status_code", None) or getattr(response, "status_code", None)
        if not code and isinstance(status_code, int):
            code = str(status_code)
        if not code:
            code = "unknown"
        request_id = ""
        for source in (body, error_body if isinstance(error_body, dict) else {}):
            request_id = str(source.get("request_id") or source.get("trace_id") or "")
            if request_id:
                break
        if not request_id and response is not None:
            headers = getattr(response, "headers", {})
            request_id = str(headers.get("request-id") or headers.get("x-request-id") or
                             headers.get("trace_id") or headers.get("Trace-Id") or "")
        request_id = re.sub(r"[^A-Za-z0-9._:-]", "", request_id)[:128]
        return MiniMaxErrorDetails(
            code=code,
            error_type=error_type,
            request_id=request_id,
            summary=_ERROR_MESSAGES.get(
                code,
                _HTTP_ERROR_MESSAGES.get(code, "MiniMax 未返回已收录的错误码，请使用诊断编号排查"),
            ),
            description_key=(
                f"chatUi.minimaxErrorCodes.code{code}"
                if code in _ERROR_MESSAGES
                else f"chatUi.minimaxErrorCodes.http{code}"
                if code in _HTTP_ERROR_MESSAGES
                else "chatUi.minimaxErrorCodes.unknown"
            ),
        )
    return None


class MiniMaxAdapter(ProviderAdapter):
    name = "minimax"
    api_format = "anthropic"
    cache_mode = "active"
    default_base_url = "https://api.minimaxi.com/anthropic"
    transient_exceptions = (IndexError, KeyError, AttributeError)
    _MARKERS = ("]<]minimax", "[e~[")

    def capabilities(self, model: str = "") -> ProviderCapabilities:
        model_l = (model or "").lower()
        cache = model_l.startswith(("minimax-m2", "minimax-m3"))
        thinking = model_l.startswith(("minimax-m2", "minimax-m3"))
        return ProviderCapabilities(api_format="anthropic", cache_mode="active" if cache else "none",
                                    thinking=thinking, tools=True,
                                    image=model_l.startswith("minimax-m3"),
                                    video=model_l.startswith("minimax-m3"))

    def supported_api_formats(self, ai):
        # 官方提供 Anthropic、Chat Completions 与 Responses；Anthropic 仍为默认协议。
        return ("anthropic", "openai", "responses")

    def default_base_url_for(self, ai) -> str:
        if self.protocol_format(ai) in {"openai", "responses"}:
            return "https://api.minimax.cn/v1"
        return self.default_base_url

    def supports_responses_prompt_cache_key(self, ai) -> bool:
        return self.protocol_format(ai) == "responses"

    def reasoning_capabilities(self, ai, api_format: str) -> ReasoningCapabilities:
        if api_format not in self.supported_api_formats(ai):
            return ReasoningCapabilities()
        model = (getattr(ai, "model", "") or "").strip().lower()
        if model.startswith("minimax-m3.1-flash-preview"):
            return ReasoningCapabilities(
                modes=("adaptive",),
                efforts=("low", "medium", "high", "xhigh", "max"),
            )
        if model.startswith(("minimax-m3", "minimax-m2")):
            if api_format == "responses":
                if model.startswith("minimax-m3"):
                    # Responses 的 M3 仅用 none/非 none 开关推理，不调节推理深度。
                    return ReasoningCapabilities(modes=("disabled", "adaptive"))
                # M2.x 推理始终开启，none 会被忽略。
                return ReasoningCapabilities(modes=("adaptive",))
            if api_format == "openai" and model.startswith("minimax-m3"):
                is_documented_adaptive_model = not model.startswith("minimax-m3.1")
                return ReasoningCapabilities(
                    modes=("disabled", "adaptive"),
                    supports_adaptive_thinking=is_documented_adaptive_model,
                )
            return ReasoningCapabilities(modes=("adaptive",))
        return ReasoningCapabilities()

    def build_responses_reasoning_params(self, ai) -> dict:
        if self.protocol_format(ai) != "responses":
            return {}
        model = (getattr(ai, "model", "") or "").strip().lower()
        value = getattr(ai, "thinking", None)
        if model.startswith("minimax-m3") and not model.startswith("minimax-m3.1-flash-preview"):
            if value == "adaptive":
                # 官方说明 M3 的任意非 none effort 只负责开启推理，不控制深度。
                return {"reasoning": {"effort": "high"}}
            # M3 默认关闭推理；disabled 与 default 均无需传参。
            return {}
        return super().build_responses_reasoning_params(ai)

    def build_thinking_params(self, ai, *, thinking: str | None = None) -> dict:
        if self.protocol_format(ai) != "openai":
            return {}
        model = (getattr(ai, "model", "") or "").strip().lower()
        capabilities = self.reasoning_capabilities(ai, "openai")
        value = thinking if thinking is not None else getattr(ai, "thinking", None)
        if value not in capabilities.modes:
            return {}
        if value == "disabled" and model.startswith("minimax-m3"):
            return {"thinking": {"type": "disabled"}}
        if value == "adaptive":
            return {"thinking": {"type": "adaptive"}}
        return {}

    def build_openai_thinking_kwargs(self, ai, *, thinking: str | None = None) -> dict:
        value = thinking if thinking is not None else getattr(ai, "thinking", None)
        params = self.build_thinking_params(ai, thinking=value)
        kwargs = {"extra_body": params} if params else {}
        if value == "adaptive":
            effort = self._reasoning_effort(ai, "openai")
            if effort:
                kwargs["reasoning_effort"] = effort
        return kwargs

    def supports_active_cache(self, model: str = "") -> bool:
        return self.capabilities(model).cache_mode == "active"

    def supports_video(self, model: str = "") -> bool:
        # 兼容当前配置中 MiniMax M3 的多种模型 ID（如 abab-m3）。
        return "m3" in (model or "").lower()

    def stream_sanitize_markers(self) -> tuple[str, ...]:
        return self._MARKERS

    def build_anthropic_generation_params(self, ai) -> dict:
        # temperature 已全局下线（anthropic SDK 1.x 的 stream()/create() 不再接受
        # 顶层 temperature，模型一律用 provider 默认采样）。
        return {}

    def video_limits(self) -> MediaLimits:
        return MediaLimits()
