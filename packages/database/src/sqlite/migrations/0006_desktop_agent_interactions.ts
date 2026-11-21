import type SQLite from 'better-sqlite3'

/** 将交互提示绑定到同一 owner 的会话和 Agent 运行。 */
export function initializeDesktopAgentInteractions(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_agent_run_models (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL, model_id TEXT NOT NULL,
      PRIMARY KEY(user_id, session_id, run_id),
      FOREIGN KEY(user_id, session_id, run_id)
        REFERENCES agent_run_admissions(user_id, session_id, run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_interaction_bindings (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      prompt_id INTEGER PRIMARY KEY REFERENCES interaction_prompts(id) ON DELETE CASCADE,
      UNIQUE(user_id, session_id, run_id, interaction_id),
      FOREIGN KEY(user_id, session_id, run_id)
        REFERENCES agent_run_checkpoints(user_id, session_id, run_id) ON DELETE CASCADE
    );
  `)).immediate()
}
