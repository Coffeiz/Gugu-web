from fastapi.testclient import TestClient

from loopscope import main
from loopscope.storage import TraceStore


def test_collector_and_query_api(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "store", TraceStore(tmp_path / "api.db"))
    client = TestClient(main.app)
    payload = {
        "id": "run-api-1",
        "session_key": "gugu:web:7",
        "external_session_id": "7",
        "source": "web",
        "status": "success",
        "started_at": 10.0,
        "ended_at": 10.1,
        "duration_ms": 100,
        "input": {"user_message": "hello"},
        "output": {"text": "world"},
        "attributes": {},
        "spans": [],
    }
    assert client.post("/api/collector/runs", json=payload).status_code == 200
    sessions = client.get("/api/sessions").json()
    assert sessions[0]["external_session_id"] == "7"
    runs = client.get("/api/sessions/gugu:web:7/runs").json()
    assert runs[0]["id"] == "run-api-1"
    run = client.get("/api/runs/run-api-1").json()
    assert run["output"]["text"] == "world"
    summary = client.get("/api/runs/run-api-1?include_spans=false").json()
    assert "spans" not in summary
    assert client.get("/api/runs/run-api-1/spans").json()["items"] == []


def test_collector_rejects_incomplete_payload(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "store", TraceStore(tmp_path / "bad.db"))
    client = TestClient(main.app)
    response = client.post("/api/collector/runs", json={"id": "missing-session"})
    assert response.status_code == 400
