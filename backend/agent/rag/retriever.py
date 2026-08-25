"""Knowledge RAG 的来源无关 Retriever 注册与候选契约。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from agent.rag.models import RecallCandidate, RecallResult


@dataclass(frozen=True)
class RetrievalBatch:
    """一个来源返回的候选结果，不负责最终字符预算和上下文注入。"""

    source_type: str
    results: tuple[RecallResult, ...] = ()
    index_source: str = "unknown"
    fallback_reason: str | None = None
    candidate_count: int = 0
    metadata: dict[str, str] = field(default_factory=dict)

    def candidates(self) -> tuple[RecallCandidate, ...]:
        """把来源结果转换为统一 Phase 1 候选，保留来源内 rank。"""
        return tuple(
            RecallCandidate.from_result(result, rank=index)
            for index, result in enumerate(self.results, start=1)
        )


class SourceRetriever(Protocol):
    """单一 Knowledge 来源的候选召回协议。"""

    source_type: str

    async def retrieve(
        self,
        query: str,
        *,
        scope: str,
        strategy: str,
        candidate_limit: int,
    ) -> RetrievalBatch: ...


class UnifiedRetriever:
    """按 source_type 调度来源 Retriever，权限和结果预算仍由上层统一收口。"""

    def __init__(self, retrievers: list[SourceRetriever] | None = None):
        self._retrievers: dict[str, SourceRetriever] = {}
        for retriever in retrievers or []:
            self.register(retriever)

    def register(self, retriever: SourceRetriever) -> None:
        source_type = str(retriever.source_type or "").strip()
        if not source_type:
            raise ValueError("Retriever 必须声明 source_type")
        if source_type in self._retrievers:
            raise ValueError(f"Retriever 重复注册：{source_type}")
        self._retrievers[source_type] = retriever

    def sources(self) -> tuple[str, ...]:
        return tuple(self._retrievers)

    async def retrieve(
        self,
        query: str,
        *,
        source: str = "all",
        scope: str = "auto",
        strategy: str = "auto",
        candidate_limit: int = 20,
    ) -> list[RetrievalBatch]:
        if source == "all":
            selected = list(self._retrievers.values())
        else:
            retriever = self._retrievers.get(source)
            selected = [retriever] if retriever is not None else []
        return [
            await retriever.retrieve(
                query,
                scope=scope,
                strategy=strategy,
                candidate_limit=candidate_limit,
            )
            for retriever in selected
        ]


__all__ = ["RecallCandidate", "RetrievalBatch", "SourceRetriever", "UnifiedRetriever"]
