from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any


def _default_db_path() -> Path:
    here = Path(__file__).resolve()
    return (here.parents[2] / "data" / "loopscope.db").resolve()


class TraceStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path or os.getenv("LOOPSCOPE_DB_PATH") or _default_db_path())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def init(self) -> None:
        with self._connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
              session_key TEXT PRIMARY KEY,
              external_session_id TEXT,
              source TEXT NOT NULL DEFAULT 'unknown',
              title TEXT NOT NULL DEFAULT 'Untitled session',
              created_at REAL NOT NULL,
              updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
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
            CREATE INDEX IF NOT EXISTS idx_runs_session_started
              ON runs(session_key, started_at DESC);
            CREATE TABLE IF NOT EXISTS spans (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
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
            CREATE INDEX IF NOT EXISTS idx_spans_run_ordinal
              ON spans(run_id, ordinal);
            """)

    @staticmethod
    def _dump(value: Any) -> str:
        return json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _load(value: str | None) -> Any:
        if not value:
            return {}
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value

    def ingest_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        run_id = str(payload["id"])
        session_key = str(payload["session_key"])
        started = float(payload.get("started_at") or 0)
        ended = payload.get("ended_at")
        user_input = payload.get("input") or {}
        title_source = str(user_input.get("user_message") or payload.get("title") or "").strip()
        title = (title_source[:48] or f"Session {payload.get('external_session_id') or session_key}")
        spans = payload.get("spans") or []

        with self._connect() as db:
            db.execute(
                """INSERT INTO sessions(session_key, external_session_id, source, title, created_at, updated_at)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(session_key) DO UPDATE SET
                     external_session_id=excluded.external_session_id,
                     source=excluded.source,
                     updated_at=excluded.updated_at,
                     title=CASE WHEN sessions.title LIKE 'Session %' OR sessions.title='Untitled session'
                                THEN excluded.title ELSE sessions.title END""",
                (
                    session_key,
                    str(payload.get("external_session_id") or ""),
                    str(payload.get("source") or "unknown"),
                    title,
                    started,
                    float(ended or started),
                ),
            )
            db.execute(
                """INSERT OR REPLACE INTO runs
                   (id, session_key, trace_id, status, started_at, ended_at, duration_ms,
                    input_json, output_json, attributes_json, raw_json)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    run_id,
                    session_key,
                    str(payload.get("trace_id") or ""),
                    str(payload.get("status") or "success"),
                    started,
                    float(ended) if ended is not None else None,
                    payload.get("duration_ms"),
                    self._dump(payload.get("input")),
                    self._dump(payload.get("output")),
                    self._dump(payload.get("attributes")),
                    self._dump(payload),
                ),
            )
            db.execute("DELETE FROM spans WHERE run_id=?", (run_id,))
            for ordinal, span in enumerate(spans):
                db.execute(
                    """INSERT INTO spans
                       (id, run_id, parent_span_id, kind, name, status, started_at, ended_at,
                        duration_ms, input_json, output_json, attributes_json, ordinal)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        str(span.get("id") or f"{run_id}:{ordinal}"),
                        run_id,
                        span.get("parent_span_id"),
                        str(span.get("kind") or "custom"),
                        str(span.get("name") or "span"),
                        str(span.get("status") or "success"),
                        float(span.get("started_at") or started),
                        float(span["ended_at"]) if span.get("ended_at") is not None else None,
                        span.get("duration_ms"),
                        self._dump(span.get("input")),
                        self._dump(span.get("output")),
                        self._dump(span.get("attributes")),
                        ordinal,
                    ),
                )
        return {"ok": True, "run_id": run_id, "spans": len(spans)}

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT s.*, COUNT(r.id) run_count,
                          SUM(CASE WHEN r.status='error' THEN 1 ELSE 0 END) error_count
                   FROM sessions s LEFT JOIN runs r ON r.session_key=s.session_key
                   GROUP BY s.session_key ORDER BY s.updated_at DESC"""
            ).fetchall()
        return [dict(r) for r in rows]

    def list_runs(self, session_key: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM runs WHERE session_key=? ORDER BY started_at ASC", (session_key,)
            ).fetchall()
        return [self._run_row(r, include_spans=False) for r in rows]

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                return None
            spans = db.execute(
                "SELECT * FROM spans WHERE run_id=? ORDER BY ordinal", (run_id,)
            ).fetchall()
        run = self._run_row(row, include_spans=False)
        run["spans"] = [self._span_row(s) for s in spans]
        return run

    def _run_row(self, row: sqlite3.Row, include_spans: bool) -> dict[str, Any]:
        d = dict(row)
        d["input"] = self._load(d.pop("input_json"))
        d["output"] = self._load(d.pop("output_json"))
        d["attributes"] = self._load(d.pop("attributes_json"))
        d.pop("raw_json", None)
        return d

    def _span_row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["input"] = self._load(d.pop("input_json"))
        d["output"] = self._load(d.pop("output_json"))
        d["attributes"] = self._load(d.pop("attributes_json"))
        return d
