from pathlib import Path

from loopscope.storage import TraceStore


def test_ingest_and_read_run(tmp_path: Path):
    store = TraceStore(tmp_path / "scope.db")
    payload = {
        "id": "run-1",
        "trace_id": "abc",
        "session_key": "gugu:web:12",
        "external_session_id": "12",
        "source": "web",
        "status": "success",
        "started_at": 1.0,
        "ended_at": 1.25,
        "duration_ms": 250,
        "input": {"user_message": "帮我看看今天的安排"},
        "output": {"text": "今天有两个日程"},
        "attributes": {"tokens": {"input": 100, "output": 20}},
        "spans": [
            {
                "id": "span-1",
                "kind": "llm",
                "name": "LLM round 1",
                "status": "success",
                "started_at": 1.0,
                "ended_at": 1.2,
                "duration_ms": 200,
                "input": {"prompt": "system"},
                "output": {"draft": "..."}, 
                "attributes": {},
            }
        ],
    }
    store.ingest_run(payload)
    sessions = store.list_sessions()
    assert sessions[0]["session_key"] == "gugu:web:12"
    assert sessions[0]["run_count"] == 1

    run = store.get_run("run-1")
    assert run is not None
    assert run["output"]["text"] == "今天有两个日程"
    assert run["spans"][0]["kind"] == "llm"
