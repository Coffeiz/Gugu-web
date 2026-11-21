import type SQLite from 'better-sqlite3'

/** 将确认意图及单次回执绑定到桌面 Agent 运行，随运行删除。 */
export function initializeDesktopAgentConfirmations(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_agent_confirmation_intents (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      intent_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL UNIQUE,
      round_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      action TEXT NOT NULL,
      targets_digest TEXT NOT NULL,
      versions_digest TEXT NOT NULL,
      authorization_epoch TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      receipt_id TEXT UNIQUE,
      claimed_at INTEGER,
      CHECK (claimed_at IS NULL OR receipt_id IS NOT NULL),
      PRIMARY KEY (user_id, session_id, run_id, interaction_id),
      FOREIGN KEY (user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );
  `)).immediate()
}
