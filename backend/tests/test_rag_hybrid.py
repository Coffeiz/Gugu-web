from agent.rag.hybrid import hybrid_results
from agent.rag.models import IndexDocument, RecallResult, Scope


def _doc(name: str, score: float):
    doc = IndexDocument(name, "memory", name, Scope("user-a"), name, "", name, "v1")
    return RecallResult(doc, score)


def test_hybrid_uses_cached_vectors_and_is_stable():
    lexical = [_doc("词法命中", 1.0), _doc("语义命中", 0.8)]
    vectors = {item.document.chunk_id: [1.0, 0.0] for item in lexical}
    vectors[lexical[1].document.chunk_id] = [0.0, 1.0]
    results, fallback = hybrid_results(lexical, [item.document for item in lexical], [0.0, 1.0], vectors)
    assert fallback is None
    assert results[0].document.source_id == "语义命中"


def test_hybrid_falls_back_without_cache():
    lexical = [_doc("词法命中", 1.0)]
    results, fallback = hybrid_results(lexical, [item.document for item in lexical], [1.0], {})
    assert fallback == "embedding_cache_unavailable"
    assert results == lexical
