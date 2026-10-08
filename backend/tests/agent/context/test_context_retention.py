from types import SimpleNamespace

from agent.context.retention import protected_message_ids, protected_unit_offset


def _row(message_id, run_id=None, round_id=None, batch_id=None):
    return SimpleNamespace(
        id=message_id,
        run_id=run_id,
        round_id=round_id,
        canonical_batch_id=batch_id,
    )


def test_protects_last_ten_rounds_of_latest_completed_run():
    rows = [_row(1, "older", "round-1")]
    rows.extend(
        _row(index + 2, "latest", f"round-{index // 2 + 1}")
        for index in range(24)
    )

    protected = protected_message_ids(rows)

    # 最新 run 有 12 轮，每轮两条 canonical 消息；只保留 round-3 到 round-12。
    assert protected == set(range(6, 26))


def test_legacy_history_fallback_keeps_ten_complete_batch_units():
    rows = [_row(1, batch_id=100), _row(2, batch_id=100)]
    rows.extend(_row(index + 3) for index in range(11))

    protected = protected_message_ids(rows)

    # 最后十个兼容单元保留，开头的 canonical batch 已落到窗口外。
    assert protected == set(range(4, 14))


def test_shared_round_policy_selects_tail_units_without_char_budget():
    assert protected_unit_offset([[0], [1, 2], [3], [4]], keep_rounds=2) == 2
    assert protected_unit_offset([[0], [1]], keep_rounds=10) == 0


def test_missing_recent_run_identity_does_not_pin_oldest_run():
    """混合历史的近期消息缺归属时，不能保护旧 run 而阻止 baseline 前移。"""
    rows = [_row(1, "old-run", "round-1")]
    rows.extend(_row(index) for index in range(2, 15))
    assert protected_message_ids(rows) == set(range(5, 15))
