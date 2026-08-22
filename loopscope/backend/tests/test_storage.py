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
    summary = store.get_run("run-1", include_spans=False)
    assert summary is not None
    assert "spans" not in summary
    assert store.list_spans("run-1", limit=1)["items"][0]["kind"] == "llm"


def test_list_runs_returns_latest_summaries(tmp_path: Path):
    store = TraceStore(tmp_path / "summary.db")
    for index in range(25):
        store.ingest_run(
            {
                "id": f"run-{index}",
                "session_key": "gugu:web:12",
                "status": "success",
                "started_at": float(index),
                "ended_at": float(index) + 0.1,
                "input": {"large": "x" * 1000},
                "output": {"text": "result"},
                "attributes": {"model": "test"},
                "spans": [],
            }
        )

    summaries = store.list_runs("gugu:web:12", limit=3)
    assert [run["id"] for run in summaries] == ["run-22", "run-23", "run-24"]
    assert "input" not in summaries[0]
    assert "output" not in summaries[0]
    assert store.list_runs("gugu:web:12", limit=3, before=23.0)[-1]["id"] == "run-22"
