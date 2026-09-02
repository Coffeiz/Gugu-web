from scripts.diagnostics.test_full_schema_compact_ab import (
    aggregate_usage_rows,
    matches_expected,
    schema_mismatch,
    sequence_metrics,
)


def test_note_create_validation_ignores_block_field_order():
    expected = {
        "blocks": [
            {"type": "paragraph", "content": [{"type": "text", "text": "下周检查接口文档"}]}
        ]
    }
    actual = {
        "blocks": [
            {"content": [{"text": "下周检查接口文档", "type": "text"}], "type": "paragraph"}
        ]
    }

    assert matches_expected("note_create", actual, expected)
    assert schema_mismatch("note_create", actual, expected) is None


def test_note_create_diagnostic_points_to_nested_content_type():
    expected = {
        "blocks": [
            {"type": "paragraph", "content": [{"type": "text", "text": "下周检查接口文档"}]}
        ]
    }
    actual = {
        "blocks": [{"type": "paragraph", "content": "下周检查接口文档"}]
    }

    mismatch = schema_mismatch("note_create", actual, expected)
    assert mismatch["mismatched"]["blocks[0].content"] == {
        "expected_type": "list", "actual_type": "str",
    }


def test_note_create_diagnostic_points_to_block_type():
    expected = {
        "blocks": [
            {"type": "paragraph", "content": [{"type": "text", "text": "下周检查接口文档"}]}
        ]
    }
    actual = {
        "blocks": [
            {"type": "text", "content": [{"type": "text", "text": "下周检查接口文档"}]}
        ]
    }

    mismatch = schema_mismatch("note_create", actual, expected)

    assert mismatch["mismatched"]["blocks[0].type"] == {
        "expected": "paragraph", "actual": "text",
    }


def test_usage_aggregation_records_all_provider_requests_in_a_run():
    usage = aggregate_usage_rows(
        [
            {"input": 100, "context_input": 10, "output": 5, "cache_read": 80},
            {"input": 140, "context_input": 12, "output": 7, "cache_read": 120},
        ],
        anthropic=False,
    )

    assert usage["provider_request_count"] == 2
    assert usage["provider_input"] == 240
    assert usage["cache_read"] == 200
    assert usage["first_provider_input"] == 100
    assert usage["last_provider_input"] == 140
    assert len(usage["provider_requests"]) == 2


def test_sequence_metrics_uses_latest_context_and_provider_totals():
    rows = [
        {
            "accurate": True,
            "usage": {
                "input": 100,
                "provider_input": 100,
                "provider_input_latest": 60,
                "output": 5,
                "cache_read": 80,
                "provider_request_count": 2,
            },
        },
        {
            "accurate": True,
            "usage": {
                "input": 140,
                "provider_input": 140,
                "provider_input_latest": 90,
                "output": 7,
                "cache_read": 120,
                "provider_request_count": 3,
            },
        },
    ]

    summary = sequence_metrics(rows, anthropic=False)

    assert summary["first_context_input"] == 60
    assert summary["last_context_input"] == 90
    assert summary["run_input_total"] == 240
    assert summary["provider_input_total"] == 240
    assert summary["cache_read_total"] == 200
    assert summary["provider_request_total"] == 5
    assert summary["context_input_monotonic"] is True
