from agent.context import builder


def test_memory_snapshot_notice_precedes_injected_memory_and_directs_search_for_gaps():
    _, dynamic, _ = builder.build_split(
        "default",
        "测试用户",
        [],
        [],
        memory={"memory": "## 记录长期记忆：旧决定\n\n曾确认保留简洁方案。"},
    )

    assert dynamic.startswith("## 记忆范围")
    assert "不保证覆盖全部历史" in dynamic
    assert "未在此处出现，不代表用户没提过" in dynamic
    assert "先调用 `search_memory` 检索，再回答" in dynamic
    assert dynamic.index("## 记忆范围") < dynamic.index("## 长期记忆")


def test_empty_memory_snapshot_does_not_claim_history_has_no_records():
    block = builder._memory_block({})

    assert "## 记忆范围" in block
    assert "这不代表完整历史中没有相关记录" in block
    assert "## 关于这位用户的记忆" in block
