"""SourceAdapter 协议。"""
from __future__ import annotations

from typing import Protocol

from agent.rag.models import IndexDocument, Scope


class SourceAdapter(Protocol):
    source_type: str

    async def build_documents(self, *, scope: Scope) -> list[IndexDocument]:
        """生成当前 scope 可召回的摘要/chunk，不返回原始二进制。"""

