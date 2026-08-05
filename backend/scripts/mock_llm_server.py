"""E2E 专用假 LLM 服务：只实现 OpenAI 兼容的流式 /v1/chat/completions，
返回一段固定文本、不带任何 tool_calls。

CI 里定时任务「立即运行」流程需要 agent 真的跑通一轮 LLM 调用才能拿到确定性的
成功结果，但接真实模型既要密钥又要花钱、还不确定性（可能被限流/超时）。这个假
服务把 AISettings.base_url 指向自己，跳过外部依赖，换来完全确定的返回内容。

用法：PYTHONPATH=. uvicorn scripts.mock_llm_server:app --port 8899
"""
from __future__ import annotations

import json
import time

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()

FIXED_REPLY = "已完成（E2E 假 LLM 固定回复，仅用于验证定时任务执行链路）"


def _chunk(content: str | None = None, finish_reason: str | None = None) -> str:
    payload = {
        "id": "chatcmpl-e2e-fixed",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "e2e-mock",
        "choices": [{
            "index": 0,
            "delta": ({"content": content} if content is not None else {}),
            "finish_reason": finish_reason,
        }],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _stream():
    yield _chunk(content=FIXED_REPLY)
    yield _chunk(finish_reason="stop")
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    if not body.get("stream", True):
        return {
            "id": "chatcmpl-e2e-fixed",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "e2e-mock",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": FIXED_REPLY},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    return StreamingResponse(_stream(), media_type="text/event-stream")
