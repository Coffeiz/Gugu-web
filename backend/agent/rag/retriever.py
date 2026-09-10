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
    # Phase 5 统一查询：worker 内已完成融合+排序时，(candidate, text, row) 三元组
    # 随批次上送，上层 UnifiedRecallService 跳过独立的 rank_candidates 步骤。
    rank_rows: tuple = field(default_factory=tuple)
    rank_stats: dict | None = None

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
    """按 source_type 注册来源 Retriever 的容器；交付统一走 TS worker（Phase 5）。

    旧的多请求逐来源调度已随 legacy 查询链删除（2026-09-09 清理）；本类只保留
    注册表职责，供统一查询主链枚举来源、装载语料和收口 scope。
    """

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


__all__ = ["RecallCandidate", "RetrievalBatch", "SourceRetriever", "UnifiedRetriever"]
