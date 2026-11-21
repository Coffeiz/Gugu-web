import type SQLite from 'better-sqlite3'

/** 保存不含凭据值的桌面表单意图。 */
export function initializeDesktopAgentCredentials(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_agent_credential_intents (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      configuration_version TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id, run_id, interaction_id),
      FOREIGN KEY (user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );
  `)).immediate()
}
