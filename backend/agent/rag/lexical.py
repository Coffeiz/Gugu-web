"""轻量 BM25：中文字符 n-gram + 英文/数字 token。"""
from __future__ import annotations

import math
import re
from collections import Counter

from agent.rag.models import IndexDocument, RecallResult

_TOKEN = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]")


def tokenize(text: str) -> list[str]:
    raw = _TOKEN.findall((text or "").lower())
    output: list[str] = []
    for token in raw:
        output.append(token)
        if len(token) > 1 and token.isascii():
            output.extend(token[index:index + 2] for index in range(len(token) - 1))
    return output


class BM25:
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
        for index, doc in enumerate(self.documents):
            length = len(self.tokens[index]) or 1
            score = 0.0
            for term in query_terms:
                freq = self.term_freq[index].get(term, 0)
                if not freq:
                    continue
                df = self.doc_freq.get(term, 0)
                idf = math.log(1 + (total - df + 0.5) / (df + 0.5))
                norm = freq + self.k1 * (1 - self.b + self.b * length / (self.avg_len or 1))
                score += idf * freq * (self.k1 + 1) / norm
            if score > min_score:
                scored.append(RecallResult(doc, score))
        scored.sort(key=lambda item: (-item.score, item.document.chunk_id))
        return scored[:max(1, min(limit, 10))]
