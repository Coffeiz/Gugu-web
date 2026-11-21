import type SQLite from 'better-sqlite3'

export function initializeDesktopAgentContinuations(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_agent_continuations (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      reference TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      nonce BLOB NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY (user_id,session_id,run_id),
      FOREIGN KEY (user_id,session_id,run_id)
        REFERENCES agent_run_checkpoints(user_id,session_id,run_id) ON DELETE CASCADE
    );
  `)).immediate()
}
