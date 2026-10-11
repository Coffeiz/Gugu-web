from agent.rag.models import IndexDocument, RecallCandidate, RecallResult, Scope, content_hash


def test_index_document_identity_is_stable():
    scope = Scope("user-a")
    first = IndexDocument("memory:x", "memory", "memory", scope, "标题", "摘要", "正文", "v1")
    second = IndexDocument("memory:x", "memory", "memory", scope, "标题", "摘要", "正文", "v1")
    assert first.identity() == second.identity()
    assert first.content_hash == content_hash("正文")
    assert first.chunk_id == "memory:x:v1:0"


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


def test_conversation_public_text_contains_context_but_content_hash_does_not():
    document = IndexDocument(
        "conversation:12", "conversation", "12", Scope("user-a"),
        "会话", "", "user：当前问题", "v1",
        metadata={
            "context_before": "user：上一句",
            "context_after": "assistant：下一句",
        },
    )

    assert document.content_hash == content_hash("user：当前问题")
    assert document.contextual_content() == "user：上一句\nuser：当前问题\nassistant：下一句"
    assert document.as_public_result(0.8)["text"] == document.contextual_content()
