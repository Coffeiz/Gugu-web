import type SQLite from 'better-sqlite3'

/** 安装桌面个人记忆和运行工具收据；已有会话数据保留原样。 */
export function initializeDesktopAgentMemory(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_agent_memory (
      user_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('profile', 'pattern')),
      body TEXT NOT NULL,
      PRIMARY KEY(user_id, target)
    );
    CREATE TABLE IF NOT EXISTS desktop_agent_memory_receipts (
      user_id TEXT NOT NULL, session_id INTEGER NOT NULL, run_id TEXT NOT NULL,
      round_id TEXT NOT NULL, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(user_id,session_id,run_id,round_id,call_id),
      FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS desktop_agent_memory_documents (
      user_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('summary', 'daily', 'stance', 'lens')),
      body TEXT NOT NULL,
      PRIMARY KEY(user_id, target)
    );
    CREATE TABLE IF NOT EXISTS desktop_agent_reflection_jobs (
      user_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL,
      model_identity TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY(user_id,session_id,run_id),
      FOREIGN KEY(user_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS desktop_agent_reflection_jobs_pending
      ON desktop_agent_reflection_jobs(user_id,session_id,status,created_at_ms);
    CREATE TABLE IF NOT EXISTS desktop_im_memory_tombstones (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      bot_id TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('group','platform-user')),
      scope_id TEXT NOT NULL,
      PRIMARY KEY(owner_id,platform,bot_id,scope_type,scope_id)
    );
  `))()
}
