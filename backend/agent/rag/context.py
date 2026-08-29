"""RAG 查询使用的当前 snapshot 注入边界。"""
from __future__ import annotations

from contextvars import ContextVar


_snapshot_context: ContextVar[str] = ContextVar("rag_snapshot_context", default="")
_snapshot_revision: ContextVar[str] = ContextVar("rag_snapshot_revision", default="")
_shared_index_key: ContextVar[str] = ContextVar("rag_shared_index_key", default="")
_conversation_before_message_id: ContextVar[int | None] = ContextVar(
    "rag_conversation_before_message_id", default=None,
)


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


def get_conversation_before_message_id() -> int | None:
    """返回本轮 conversation RAG 的排他上界；当前消息及之后的消息不可见。"""
    return _conversation_before_message_id.get()


def set_conversation_before_message_id(value: object | None):
    """绑定当前 run 的 conversation 可见性水位并返回 ContextVar token。"""
    normalized = None if value is None else int(value)
    return _conversation_before_message_id.set(normalized)


def reset_conversation_before_message_id(token) -> None:
    _conversation_before_message_id.reset(token)
