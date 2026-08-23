from agent.memory.store import DAILY_INJECT_CHARS, MEMORY_INJECT_CHARS, retrieve_memory_block


def test_memory_injection_budgets_are_two_thousand_chars():
    assert DAILY_INJECT_CHARS == 2000
    assert MEMORY_INJECT_CHARS == 2000


def test_memory_fallback_respects_hard_budget_without_embedding():
    text = "甲" * 2500
    assert len(retrieve_memory_block(text, None, None)) == MEMORY_INJECT_CHARS


def test_memory_fallback_respects_hard_budget_when_vector_coverage_is_insufficient():
    text = "第一段\n\n" + ("乙" * 2500)
    assert len(retrieve_memory_block(text, [1.0], {})) <= MEMORY_INJECT_CHARS
