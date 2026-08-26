"""RAG 查询使用的当前 snapshot 注入边界。"""
from __future__ import annotations

from contextvars import ContextVar


_snapshot_context: ContextVar[str] = ContextVar("rag_snapshot_context", default="")
_snapshot_revision: ContextVar[str] = ContextVar("rag_snapshot_revision", default="")
_shared_index_key: ContextVar[str] = ContextVar("rag_shared_index_key", default="")


def set_snapshot_context(text: str | None) -> None:
    """登记当前请求已经注入 snapshot 的上下文文本。"""
    _snapshot_context.set(str(text or ""))


def set_snapshot_revision(revision: object | None) -> None:
    """登记当前 session snapshot 的 RAG revision。

    ``0`` 是新 session 的有效 snapshot 版本，不能按 falsey 值当成“没有版本”。
    """
    _snapshot_revision.set("" if revision is None else str(revision))


def get_snapshot_context() -> str:
    """读取当前请求的 snapshot 文本；跨请求不会共享。"""
    return _snapshot_context.get()


def get_snapshot_revision() -> str:
    """读取当前请求绑定的 snapshot revision。"""
    return _snapshot_revision.get()


def get_shared_index_key() -> str:
    return _shared_index_key.get()


def set_shared_index_key(value: str):
    return _shared_index_key.set(value)


def reset_shared_index_key(token) -> None:
    _shared_index_key.reset(token)
