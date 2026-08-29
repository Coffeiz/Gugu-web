from agent.memory.daily_compaction import merge_remaining, should_compact, split_batch


def test_split_batch_preserves_backlog_and_order():
    recent, batch, remaining = split_batch(list(range(1, 11)), keep_recent=3, batch_size=4)
    assert recent == [1, 2, 3]
    assert batch == [4, 5, 6, 7]
    assert merge_remaining(recent, remaining) == [1, 2, 3, 8, 9, 10]


def test_backlog_continues_after_first_batch():
    assert should_compact(1000, trigger=1000, keep_recent=500)
    assert should_compact(900, trigger=1000, keep_recent=500)
    assert should_compact(600, trigger=1000, keep_recent=500)
    assert not should_compact(550, trigger=1000, keep_recent=500)
