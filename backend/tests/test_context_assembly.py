from agent.context.context_assembly import build_messages


def test_build_messages_preserves_existing_layout_and_attaches_canonical_context():
    messages = build_messages(
        fixed_parts=[{"role": "system", "content": "固定"}],
        history=[{"role": "assistant", "content": "历史"}],
        current_user={"role": "user", "content": "当前"},
        dynamic_tail=[{"role": "system", "content": "时间"}],
    )
    assert [item["content"] for item in messages] == ["固定", "历史", "当前", "时间"]
    assert messages.fixed_prefix_size == 1
    assert messages.dynamic_tail == [{"role": "system", "content": "时间"}]
    assert messages.canonical_context.current_turn == ({"role": "user", "content": "当前"},)
    assert messages.canonical_context.dynamic_tail == ({"role": "system", "content": "时间"},)


def test_assemble_is_the_shared_entry_and_keeps_compatibility_name():
    from agent.context import context_assembly
    assert context_assembly.assemble is context_assembly.build_messages
