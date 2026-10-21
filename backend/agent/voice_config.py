"""语音配置的公共规则；仅在已明确选择百炼原生协议后确定产品线。"""


def dashscope_service_for_model(model: str) -> str:
    name = model.strip().lower()
    for prefix, service in (("qwen3-asr", "qwen3-asr"), ("qwen-audio", "qwen-audio"), ("fun-asr", "fun-asr")):
        if name.startswith(prefix):
            return service
    raise ValueError("百炼原生语音模型须属于 Qwen3 ASR、Qwen-Audio 或 Fun-ASR 产品线")
