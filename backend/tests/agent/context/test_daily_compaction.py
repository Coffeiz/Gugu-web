from agent.memory.daily_compaction import should_compact, split_oldest_batch


def test_split_oldest_batch_keeps_newer_backlog_in_order():
    remaining, batch = split_oldest_batch(list(range(10, 0, -1)), batch_size=4)
    assert remaining == [10, 9, 8, 7, 6, 5]
    assert batch == [4, 3, 2, 1]


def test_compaction_starts_at_threshold_and_ignores_old_keep_window():
    assert should_compact(50, trigger=50)
    assert should_compact(175, trigger=50)
    assert not should_compact(49, trigger=50)
