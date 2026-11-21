import type SQLite from 'better-sqlite3'

/** 桌面 IM 记忆反思队列；任务只保留密封收件引用和已完成回复。 */
export function initializeDesktopImReflection(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_im_reflection_jobs (
      owner_id TEXT NOT NULL,
      session_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('owner','group','platform-user')),
      scope_id TEXT NOT NULL,
      model_identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY(owner_id,session_id,run_id,scope_type,scope_id),
      FOREIGN KEY(owner_id,session_id,run_id) REFERENCES agent_run_admissions(user_id,session_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS desktop_im_reflection_jobs_pending
      ON desktop_im_reflection_jobs(owner_id,session_id,status,created_at_ms);
  `)).immediate()
}
