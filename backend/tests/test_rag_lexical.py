from agent.rag.tokenizer import tokenize
from agent.rag.legacy_lexical import LegacyBM25
from agent.rag.models import IndexDocument, Scope


def _doc(doc_id: str, text: str):
    return IndexDocument(doc_id, "memory", doc_id, Scope("user-a"), doc_id, "", text, "v1")


def test_tokenize_supports_chinese_and_english():
    tokens = tokenize("部署方案 API-v2")
    assert "部署" in tokens and "方案" in tokens
    assert "部" in tokens and "署" in tokens
    assert "api" in tokens and "api" in tokens


def test_tokenizer_is_deterministic_for_rust_index_boundary():
    assert tokenize("部署方案和缓存") == tokenize("部署方案和缓存")


def test_legacy_bm25_is_only_a_deterministic_deployment_fallback():
    docs = [_doc("other", "天气和旅行"), _doc("target", "部署方案和缓存"), _doc("same", "部署方案")]
    results = LegacyBM25(docs).search("部署方案", limit=2)
    assert {item.document.source_id for item in results} == {"target", "same"}
