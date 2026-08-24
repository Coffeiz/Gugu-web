"""Rust sidecar 部署前的临时词法回退。

仅允许在 Rust sidecar 未部署/不可用时调用。sidecar 灰度完成后删除本文件，
不要在新业务代码中直接导入。
"""
from __future__ import annotations

import math
from collections import Counter

from agent.rag.models import IndexDocument, RecallResult
from agent.rag.tokenizer import tokenize


class LegacyBM25:
    def __init__(self, documents: list[IndexDocument], *, k1: float = 1.2, b: float = 0.75):
        self.documents = list(documents)
        self.k1 = k1
        self.b = b
        self.tokens = [tokenize(doc.title + "\n" + doc.summary + "\n" + doc.content) for doc in self.documents]
        self.term_freq = [Counter(tokens) for tokens in self.tokens]
        self.doc_freq: Counter[str] = Counter()
        for terms in self.term_freq:
            self.doc_freq.update(terms.keys())
        self.avg_len = sum(len(tokens) for tokens in self.tokens) / len(self.tokens) if self.tokens else 0

    def search(self, query: str, *, limit: int = 10, min_score: float = 0.0) -> list[RecallResult]:
        query_terms = set(tokenize(query))
        if not query_terms or not self.documents:
            return []
        total = len(self.documents)
        scored: list[RecallResult] = []
        for index, document in enumerate(self.documents):
            length = len(self.tokens[index]) or 1
            score = 0.0
            for term in query_terms:
                frequency = self.term_freq[index].get(term, 0)
                if not frequency:
                    continue
                document_frequency = self.doc_freq.get(term, 0)
                idf = math.log(1 + (total - document_frequency + 0.5) / (document_frequency + 0.5))
                norm = frequency + self.k1 * (1 - self.b + self.b * length / (self.avg_len or 1))
                score += idf * frequency * (self.k1 + 1) / norm
            if score > min_score:
                scored.append(RecallResult(document, score))
        scored.sort(key=lambda item: (-item.score, item.document.chunk_id))
        return scored[:max(1, min(limit, 10))]


__all__ = ["LegacyBM25"]
