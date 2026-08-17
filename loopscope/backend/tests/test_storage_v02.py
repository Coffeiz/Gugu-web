import sqlite3
from pathlib import Path

from loopscope.storage import TraceStore


def test_v02_usage_and_provenance_roundtrip(tmp_path: Path):
    store = TraceStore(tmp_path / "scope.db")
    payload = {
        "id": "run-v02",
        "trace_id": "abc123",
        "session_key": "gugu:web:88",
        "external_session_id": "88",
        "source": "web",
        "status": "success",
        "started_at": 10.0,
        "ended_at": 10.5,
        "duration_ms": 500,
        "input": {"user_message": "hello"},
        "output": {"text": "world"},
        "attributes": {"model": "demo"},
        "usage": {
            "input": 1200,
            "output": 120,
            "cache_read": 800,
            "fresh_input": 400,
            "total": 1320,
        },
        "spans": [
            {
                "id": "run-v02:s1",
                "kind": "llm",
                "name": "LLM round 1",
                "status": "success",
                "started_at": 10.1,
                "ended_at": 10.4,
                "duration_ms": 300,
                "input": {"messages": []},
                "output": {"draft": "world"},
                "attributes": {"round": 1},
                "code": {"file": "backend/agent/loop_drivers.py", "function": "run_round", "line": 200},
                "usage": {"input": 1200, "output": 120, "cache_read": 800, "fresh_input": 400, "total": 1320},
                "token_impact": {"prompt_tokens_estimate": 1180},
            }
        ],
    }
    store.ingest_run(payload)
    run = store.get_run("run-v02")
    assert run is not None
    assert run["usage"]["cache_read"] == 800
    assert run["spans"][0]["code"]["file"] == "backend/agent/loop_drivers.py"
    assert run["spans"][0]["usage"]["input"] == 1200
    assert run["spans"][0]["token_impact"]["prompt_tokens_estimate"] == 1180


def test_v01_schema_is_migrated_in_place(tmp_path: Path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      external_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL DEFAULT 'Untitled session',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      trace_id TEXT,
      status TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      duration_ms REAL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE spans (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      duration_ms REAL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL
    );
    """)
    db.close()

    TraceStore(path)
    db = sqlite3.connect(path)
    run_cols = {row[1] for row in db.execute("PRAGMA table_info(runs)")}
    span_cols = {row[1] for row in db.execute("PRAGMA table_info(spans)")}
    db.close()
    assert "usage_json" in run_cols
    assert {"code_json", "usage_json", "token_impact_json"}.issubset(span_cols)
