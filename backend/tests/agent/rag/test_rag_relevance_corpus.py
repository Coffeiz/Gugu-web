"""旧 Cython 生产 tokenizer/BM25 在共享固定语料上的检索质量基准。"""
from __future__ import annotations

import json
from pathlib import Path

from agent.rag.cython_backend import build_text_index, search
from agent.rag.cython_tokenizer import tokenize_raw


FIXTURE = Path(__file__).resolve().parents[4] / "docs/testing/fixtures/rag-relevance-corpus.json"


def test_shared_relevance_corpus_has_stable_recall_and_empty_results():
    corpus = json.loads(FIXTURE.read_text(encoding="utf-8"))
    documents = corpus["documents"]
    index = build_text_index([item["text"] for item in documents], [item["id"] for item in documents])
    eligible_ids = {
        index_id for index_id, item in enumerate(documents)
        if item["scope_type"] == "owner" and item["scope_id"] == corpus["owner_id"]
    }

    for case in corpus["queries"]:
        hits = search(index, tokenize_raw(case["query"]), corpus["top_k"], eligible_ids=eligible_ids)
        hit_ids = [documents[index_id]["id"] for index_id, _score in hits]
        assert all(
            documents[index_id]["scope_type"] == "owner"
            and documents[index_id]["scope_id"] == corpus["owner_id"]
            for index_id, _score in hits
        ), {"case": case["id"], "hit_ids": hit_ids}
        relevant = set(case["relevant_ids"])
        recall = len(relevant.intersection(hit_ids)) / len(relevant) if relevant else 1.0
        reciprocal_rank = next((1 / rank for rank, item in enumerate(hit_ids, 1) if item in relevant), 0.0)

        assert recall == 1.0, {"case": case["id"], "hit_ids": hit_ids, "recall_at_3": recall}
        if not relevant:
            assert hit_ids == [], {"case": case["id"], "hit_ids": hit_ids}
        else:
            assert reciprocal_rank >= 0.5, {
                "case": case["id"], "hit_ids": hit_ids, "mrr": reciprocal_rank,
            }
