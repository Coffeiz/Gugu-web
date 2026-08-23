from agent.rag.lexical import BM25, tokenize
from agent.rag.models import IndexDocument, Scope


def _doc(doc_id: str, text: str):
    return IndexDocument(doc_id, "memory", doc_id, Scope("user-a"), doc_id, "", text, "v1")


def test_tokenize_supports_chinese_and_english():
    tokens = tokenize("部署方案 API-v2")
    assert "部" in tokens and "署" in tokens
    assert "api" in tokens and "api" in tokens


def test_bm25_ranks_matching_document_and_is_deterministic():
    docs = [_doc("other", "天气和旅行"), _doc("target", "部署方案和缓存"), _doc("same", "部署方案")]
    first = BM25(docs).search("部署方案", limit=2)
    second = BM25(docs).search("部署方案", limit=2)
    assert [item.document.source_id for item in first] == [item.document.source_id for item in second]
    assert {item.document.source_id for item in first} == {"target", "same"}
