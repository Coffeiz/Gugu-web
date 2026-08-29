from scripts.compare_ilike_index import _overlap_ratio, _percentile


def test_compare_metrics_are_aggregate_only_and_stable():
    assert _overlap_ratio({"project:1", "note:2"}, {"project:1"}) == 1.0
    assert _overlap_ratio({"project:1"}, {"project:2"}) == 0.0
    assert _overlap_ratio(set(), set()) == 1.0
    assert _percentile([10.0, 20.0, 30.0], 0.95) == 30.0
