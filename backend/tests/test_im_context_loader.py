from agent.im.context_loader import restore_group_memory_snapshot


def test_restore_group_memory_snapshot_migrates_legacy_group_block():
    snapshot = {
        "snapshot_context": "固定上下文",
        "im_memory": {"group": {"summary": "群近况"}},
    }

    result = restore_group_memory_snapshot(snapshot)

    assert result is snapshot
    assert "固定上下文" in result["snapshot_context"]
    assert "## 当前群组记忆（仅限本群公开信息）" in result["snapshot_context"]
    assert "群近况" in result["snapshot_context"]


def test_restore_group_memory_snapshot_does_not_duplicate_existing_block():
    context = "固定上下文\n\n## 当前群组记忆（仅限本群公开信息）\n\n已有内容"
    snapshot = {
        "snapshot_context": context,
        "im_memory": {"group": {"summary": "群近况"}},
    }

    restore_group_memory_snapshot(snapshot)

    assert snapshot["snapshot_context"] == context
