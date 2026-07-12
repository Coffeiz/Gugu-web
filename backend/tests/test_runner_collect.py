import json

from agent.runner import _collect


async def _error_stream(field: str):
    yield "data: " + json.dumps({"type": "error", field: "上游暂时繁忙"}, ensure_ascii=False) + "\n\n"


async def test_collect_reads_core_error_detail():
    text, _, _, errored, files, cancelled = await _collect(_error_stream("detail"))
    assert text == "上游暂时繁忙"
    assert errored is True
    assert files == []
    assert cancelled is False


async def test_collect_keeps_legacy_error_message():
    text, _, _, errored, _, _ = await _collect(_error_stream("message"))
    assert text == "上游暂时繁忙"
    assert errored is True
