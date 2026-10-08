from agent.rag.index_cache import _documents_fingerprint
from agent.rag.models import IndexDocument, Scope
from agent.rag import protocol


def test_rag_projection_version_participates_in_document_fingerprint(monkeypatch):
    document = IndexDocument(
        document_id="file:1",
        source_type="file",
        source_id="1",
        scope=Scope(owner_user_id="test-owner"),
        title="文档",
        summary="",
        content="正文",
        version="v1",
    )

    fingerprint = _documents_fingerprint([document])
    monkeypatch.setattr(protocol, "RAG_PROJECTION_VERSION", "rag-projection-test")
    changed_fingerprint = _documents_fingerprint([document])
    assert fingerprint != changed_fingerprint
