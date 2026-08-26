from datetime import datetime, timezone

from agent import behaviors


def test_missing_stance_uses_baseline_only():
    assert behaviors.select(None) == ["baseline"]
    assert behaviors.select("") == ["baseline"]
    assert behaviors.select("未知姿态") == ["baseline"]


def test_valid_stance_replaces_baseline():
    assert behaviors.select("记录") == ["record"]
    assert behaviors.select("查询") == ["query"]


def test_expired_stance_falls_back_to_baseline():
    old = datetime.now(timezone.utc).timestamp() - behaviors.STANCE_FRESH_SECS - 1
    assert behaviors.select("记录", old) == ["baseline"]
