from agent.rag.chunking import split_sections, split_text
from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope, content_hash


def test_index_document_identity_is_stable():
    scope = Scope("user-a")
    first = IndexDocument("memory:x", "memory", "memory", scope, "标题", "摘要", "正文", "v1")
    second = IndexDocument("memory:x", "memory", "memory", scope, "标题", "摘要", "正文", "v1")
    assert first.identity() == second.identity()
    assert first.content_hash == content_hash("正文")
    assert first.chunk_id == "memory:x:v1:0"


def test_sections_and_chunks_keep_order_and_bounds():
    sections = split_sections("前言\n\n## 第一段\n甲\n\n## 第二段\n乙")
    assert [title for title, _ in sections] == ["", "第一段", "第二段"]
    chunks = split_text("第一句。第二句。第三句。", max_chars=8, overlap=2)
    assert chunks
    assert "第一句" in chunks[0]
    assert all(len(chunk) <= 8 for chunk in chunks)


def test_recall_candidate_keeps_stable_identity_and_rank():
    document = IndexDocument(
        "memory:x", "memory", "memory", Scope("user-a"),
        "标题", "摘要", "正文", "v1",
    )
    candidate = RecallCandidate.from_result(RecallResult(document, 0.8), rank=2)

    assert candidate.source_type == "memory"
    assert candidate.source_id == "memory"
    assert candidate.content_fingerprint == document.content_hash
    assert candidate.rank == 2
    assert candidate.as_public()["score"] == 0.8
