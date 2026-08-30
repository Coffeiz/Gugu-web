from scripts.diagnostics.test_full_schema_compact_ab import (
    aggregate_usage_rows,
    matches_expected,
    schema_mismatch,
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
