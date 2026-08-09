"""全链路 trace_id：一条消息从入口到最终回复的唯一标识（商用就绪评审 P0-4）。

此前一条消息跨网关/worker 两进程、途经防抖合并 + 多轮工具调用，日志里没有任何
共同标识，出问题只能靠时间戳人工对账。现在：

- **IM 路**：网关收到消息时生成 12 位 hex，打进「收到」日志行、随 payload 入队；
  worker 消费时恢复进 ContextVar，此后同一任务里的工具轨迹（agent.traj）、回复
  日志都自动带上。防抖把多条消息合并成一轮时取最后一条的 trace（一轮=一个 trace）。
- **Web 路**：SSE stream() 入口生成，同任务内传播。
- 传播靠 ContextVar（create_task 复制、任务间隔离，同 imctx 模式），跨进程靠
  payload 字段接力。查一条消息：grep trace=xxx 同时命中网关行、worker 回复行、
  全部工具调用行。
"""
from __future__ import annotations

import uuid
from contextvars import ContextVar

_trace: ContextVar[str] = ContextVar("trace_id", default="")


def new_trace() -> str:
    """生成新 trace_id 并设为当前上下文（入口用：网关收消息 / web stream 开始）。"""
    t = uuid.uuid4().hex[:12]
    _trace.set(t)
    return t


def set_trace(t: str | None) -> str:
    """恢复上游传来的 trace_id（worker 消费队列时用）；空则新生成。"""
    t = (t or "").strip() or uuid.uuid4().hex[:12]
    _trace.set(t)
    return t


def get_trace() -> str:
    """当前上下文的 trace_id；未设置返回空串（日志侧自行省略）。"""
    return _trace.get()
