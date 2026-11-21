import type SQLite from 'better-sqlite3'

/** 在现有桌面库中以单事务安装 Agent Run 存储。 */
export function initializeDesktopAgentRuns(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run_leases (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      token TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence > 0), expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY(user_id, session_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_run_admissions (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, session_id, run_id),
      UNIQUE(user_id, session_id, user_message_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_run_controls (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      startup_failed INTEGER NOT NULL DEFAULT 0 CHECK(startup_failed IN (0, 1)),
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 0), sequence INTEGER NOT NULL CHECK(sequence >= 0),
      status TEXT NOT NULL, phase TEXT NOT NULL, nonce BLOB NOT NULL, payload BLOB NOT NULL,
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(session_id, user_id) REFERENCES conversation_sessions(id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_run_events (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      event_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
      nonce BLOB NOT NULL, payload BLOB NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
      PRIMARY KEY(user_id, session_id, run_id, sequence),
      UNIQUE(user_id, session_id, run_id, event_id),
      FOREIGN KEY(user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_run_interaction_receipts (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL, receipt TEXT NOT NULL,
      PRIMARY KEY(user_id, session_id, run_id, receipt),
      FOREIGN KEY(user_id, session_id, run_id) REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );
  `)).immediate()
}
