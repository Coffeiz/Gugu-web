from types import SimpleNamespace

from agent.runtime.loopscope_trace.cache_probe import detect_cache_drop
from agent.runtime.loopscope_trace.cache_probe import context_digests, record_cache_drop


def _round(*, at, ratio, input_tokens=100_000, cache_read=None, **extra):
    return {
        "at": at,
        "provider": "minimax",
        "model": "MiniMax-M3",
        "api_format": "anthropic",
        "cache_supported": True,
        "input_tokens": input_tokens,
        "cache_read_tokens": int(input_tokens * ratio) if cache_read is None else cache_read,
        "cache_hit_ratio": ratio,
        "stable_prefix_tokens": 40_000,
        "stable_prefix_digest": "same-prefix",
        "tool_schema_digest": "same-tools",
        "system_digest": "same-system",
        "memory_injected": True,
        "memory_digest": "memory-v1",
        "summary_digest": "summary-v1",
        **extra,
    }


def test_cache_drop_is_attributed_when_stable_prefix_is_unchanged():
    previous = _round(at=100.0, ratio=0.97)
    current = _round(at=104.0, ratio=0.001)

    result = detect_cache_drop(previous, current)

    assert result is not None
    assert result["request_gap_seconds"] == 4.0
    assert result["attribution"] == ["provider_cache_drop_unexplained"]
    assert result["prefix_unchanged"] is True
    assert result["memory_injected"] is True
    assert result["summary_changed"] is False


def test_cache_drop_reports_schema_and_summary_changes():
    previous = _round(at=100.0, ratio=0.96)
    current = _round(
        at=110.0, ratio=0.02, tool_schema_digest="new-tools",
        summary_digest="summary-v2", stable_prefix_digest="new-prefix",
    )

    result = detect_cache_drop(previous, current)

    assert result is not None
    assert "tool_schema_changed" in result["attribution"]
    assert "summary_changed" in result["attribution"]
    assert "prefix_changed" in result["attribution"]
    assert "provider_cache_drop_unexplained" not in result["attribution"]


def test_cache_drop_marks_long_gap_as_suspected_not_confirmed_ttl_expiry():
    result = detect_cache_drop(
        _round(at=100.0, ratio=0.9),
        _round(at=100 + 601, ratio=0.01),
    )

    assert result is not None
    assert "time_gap_suspected" in result["attribution"]
    assert "ttl_expired" not in result["attribution"]


def test_cache_drop_attributes_provider_switch_and_never_copies_prompt_content():
    import json

    result = detect_cache_drop(
        _round(at=100.0, ratio=0.9),
        _round(at=104.0, ratio=0.01, provider="other-provider", secret_body="不得记录"),
    )

    assert result is not None
    assert "provider_changed" in result["attribution"]
    assert "不得记录" not in json.dumps(result, ensure_ascii=False)


def test_cache_drop_ignores_cold_small_or_unsupported_requests():
    cold = detect_cache_drop(_round(at=100.0, ratio=0.1), _round(at=104.0, ratio=0.0))
    small = detect_cache_drop(
        _round(at=100.0, ratio=0.9),
        _round(at=104.0, ratio=0.0, input_tokens=10_000, stable_prefix_tokens=10_000),
    )
    unsupported = detect_cache_drop(
        _round(at=100.0, ratio=0.9),
        _round(at=104.0, ratio=0.0, cache_supported=False),
    )

    assert cold is None
    assert small is None
    assert unsupported is None


def test_context_probe_reports_memory_and_summary_without_returning_their_text():
    private_memory = "私人记忆正文不得写入探针"
    run = SimpleNamespace(
        spans=[],
        pending_context_spans=[SimpleNamespace(
            attributes={"context_source": True, "source": "memory"},
            name="Memory · profile",
            output={"content": private_memory},
        )],
    )
    messages = [{"role": "system", "content": "<compacted-summary>摘要正文</compacted-summary>"}]

    result = context_digests(messages, run)

    assert result["memory_injected"] is True
    assert result["memory_digest"]
    assert result["summary_digest"]
    assert private_memory not in repr(result)


def test_run_stores_first_full_probe_and_only_counts_later_drops():
    run = SimpleNamespace(attributes={})
    first_span = SimpleNamespace(attributes={})
    later_span = SimpleNamespace(attributes={})
    previous = _round(at=100.0, ratio=0.95)
    current = _round(at=104.0, ratio=0.001)

    record_cache_drop(run, first_span, previous, current)
    record_cache_drop(run, later_span, previous, current)

    probe = run.attributes["cache_drop_probe"]
    assert probe["event_count"] == 2
    assert len(probe["events"]) == 1
    assert first_span.attributes["cache_drop_probe"] == probe["events"][0]
    assert "cache_drop_probe" not in later_span.attributes
