from types import SimpleNamespace

from agent.runtime.loopscope_trace import cache_probe
from agent.runtime.loopscope_trace.cache_probe import (
    context_digests,
    detect_cache_drop,
    record_cache_drop,
)


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


def _reflection_observation_input(*, supported=True, prefix="stable"):
    branch_input = SimpleNamespace(
        stable_system=prefix,
        history_messages=({"role": "user", "content": "不可记录的聊天正文"},),
        tools=({"name": "secret_tool", "description": "不可记录的工具定义"},),
        cache_probe_context={
            "reflection_scope": "owner",
            "trigger_source": "idle",
            "origin_run_id": "run-origin-123",
            "origin_gap_seconds": 180.0,
        },
    )
    ai = SimpleNamespace(model="MiniMax-M3")
    adapter = SimpleNamespace(
        name="minimax",
        protocol_format=lambda _ai: "anthropic",
        supports_active_cache=lambda _model: supported,
    )
    return branch_input, ai, adapter


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


def test_reflection_cache_observation_records_usage_and_only_prefix_fingerprints():
    assert hasattr(cache_probe, "build_reflection_sample")
    branch_input, ai, adapter = _reflection_observation_input()
    observation = cache_probe.build_reflection_sample(
        branch_input, ai, adapter,
        usage={
            "input": 20_000,
            "fresh_input": 2_000,
            "cache_read": 17_000,
            "cache_write": 1_000,
            "cache_ratio": 0.85,
        },
    )

    assert observation["scenario"] == "reflection"
    assert observation["reflection_scope"] == "owner"
    assert observation["trigger_source"] == "idle"
    assert observation["origin_run_id"] == "run-origin-123"
    assert observation["origin_gap_seconds"] == 180.0
    assert observation["cache_hit_ratio"] == 0.85
    assert observation["cache_read_tokens"] == 17_000
    assert observation["stable_prefix_tokens_estimate"] > 0
    assert observation["stable_prefix_digest"]
    assert observation["system_digest"]
    assert observation["tool_schema_digest"]
    assert "不可记录的" not in repr(observation)
    assert "secret_tool" not in repr(observation)


def test_reflection_cache_ratio_uses_fresh_read_and_write_input_tokens():
    from agent.usage import (
        normalize_anthropic_usage,
        normalize_openai_usage,
        normalize_responses_usage,
    )

    branch_input, ai, adapter = _reflection_observation_input()
    normalized_samples = (
        normalize_openai_usage({
            "prompt_tokens": 20_000,
            "prompt_cache_hit_tokens": 10_000,
            "prompt_cache_creation_tokens": 2_000,
        }),
        normalize_anthropic_usage({
            "input_tokens": 8_000,
            "cache_read_input_tokens": 10_000,
            "cache_creation_input_tokens": 2_000,
        }),
        normalize_responses_usage({
            "input_tokens": 20_000,
            "input_tokens_details": {"cached_tokens": 10_000},
            "cache_creation_input_tokens": 2_000,
        }),
    )

    for usage in normalized_samples:
        observation = cache_probe.build_reflection_sample(
            branch_input, ai, adapter, usage,
        )
        assert observation["input_tokens"] == 20_000
        assert observation["fresh_input_tokens"] == 8_000
        assert observation["cache_read_tokens"] == 10_000
        assert observation["cache_write_tokens"] == 2_000
        assert observation["cache_hit_ratio"] == 0.5


def test_reflection_observation_flags_low_hit_only_for_supported_long_prefix(monkeypatch):
    monkeypatch.setattr(cache_probe, "_estimate_tokens", lambda _value, _model: 32_000)
    usage = {"input": 20_000, "cache_read": 100, "cache_ratio": 0.005}
    supported_input, ai, supported_adapter = _reflection_observation_input(supported=True)
    unsupported_input, _, unsupported_adapter = _reflection_observation_input(supported=False)
    supported = cache_probe.build_reflection_sample(
        supported_input, ai, supported_adapter, usage,
    )
    unsupported = cache_probe.build_reflection_sample(
        unsupported_input, ai, unsupported_adapter, usage,
    )

    assert supported["probe_eligible"] is True
    assert supported["cache_low_hit"] is True
    assert unsupported["probe_eligible"] is False
    assert unsupported["cache_low_hit"] is False


def test_reflection_cache_observation_is_attached_to_an_active_trace(monkeypatch):
    from agent.runtime.loopscope_trace import state

    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    run = state._ScopeRun(
        id="run-active",
        trace_id="trace-active",
        session_key="gugu:web:31",
        external_session_id="31",
        source="web",
        started_at=1.0,
    )
    token = state._scope_run.set(run)
    try:
        assert hasattr(cache_probe, "record_reflection_sample")
        cache_probe.record_reflection_sample(
            {
                "scenario": "reflection",
                "provider": "minimax",
                "model": "MiniMax-M3",
                "api_format": "anthropic",
                "input_tokens": 20_000,
                "cache_read_tokens": 17_000,
                "cache_write_tokens": 1_000,
                "cache_hit_ratio": 0.85,
                "trigger_source": "threshold",
                "origin_run_id": "run-active",
            },
            session_id=31,
        )
    finally:
        state._scope_run.reset(token)

    span = run.spans[-1]
    assert span.name == "Reflection cache observation"
    assert span.attributes["scenario"] == "reflection"
    assert span.attributes["reflection_scope"] == "unknown"
    assert span.input["reflection_cache_probe"]["trigger_source"] == "threshold"
    assert span.usage["cache_read"] == 17_000
    assert run.ended_at is None


def test_idle_reflection_without_active_trace_emits_a_detached_observation(monkeypatch):
    from agent.runtime.loopscope_trace import state

    snapshots = []
    monkeypatch.setenv("LOOPSCOPE_ENABLED", "1")
    monkeypatch.setattr(
        state, "_finish_run", lambda run, status: snapshots.append(run.snapshot())
    )
    token = state._scope_run.set(None)
    try:
        assert hasattr(cache_probe, "record_reflection_sample")
        cache_probe.record_reflection_sample(
            {
                "scenario": "reflection",
                "provider": "minimax",
                "model": "MiniMax-M3",
                "api_format": "anthropic",
                "input_tokens": 20_000,
                "cache_read_tokens": 200,
                "cache_write_tokens": 0,
                "cache_hit_ratio": 0.01,
                "trigger_source": "idle",
                "origin_run_id": "run-origin-123",
            },
            session_id=31,
        )
    finally:
        state._scope_run.reset(token)

    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert snapshot["source"] == "reflection"
    assert snapshot["session_key"] == "gugu:reflection:31"
    assert snapshot["attributes"]["scenario"] == "reflection"
    assert snapshot["attributes"]["reflection_scope"] == "unknown"
    assert snapshot["usage"]["input"] == 20_000
    assert snapshot["usage"]["fresh_input"] == 19_800
    assert snapshot["usage"]["cache_ratio"] == 0.01
    span = snapshot["spans"][-1]
    assert span["name"] == "Reflection cache observation"
    probe = span["input"]["reflection_cache_probe"]
    assert probe["trigger_source"] == "idle"
    assert probe["origin_run_id"] == "run-origin-123"
    assert span["usage"]["cache_read"] == 200
