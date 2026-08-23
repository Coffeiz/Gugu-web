"""RAG 查询使用的当前 snapshot 注入边界。"""
from __future__ import annotations

from contextvars import ContextVar


_snapshot_context: ContextVar[str] = ContextVar("rag_snapshot_context", default="")


def set_snapshot_context(text: str | None) -> None:
    """登记当前请求已经注入 snapshot 的上下文文本。"""
    _snapshot_context.set(str(text or ""))


def get_snapshot_context() -> str:
    """读取当前请求的 snapshot 文本；跨请求不会共享。"""
    return _snapshot_context.get()
