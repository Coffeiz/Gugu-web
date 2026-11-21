import type SQLite from 'better-sqlite3'

/** 准入事件和待调度状态保存在同一行，以便在重启后恢复。 */
export function initializeDesktopImInbox(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_im_inbox (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL CHECK(length(connection_id) > 0),
      event_key TEXT NOT NULL CHECK(length(event_key) > 0),
      sealed_event BLOB NOT NULL CHECK(length(sealed_event) > 0),
      received_at TEXT NOT NULL,
      session_id INTEGER,
      run_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','rejected')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      CHECK((session_id IS NULL) = (run_id IS NULL)),
      CHECK(state NOT IN ('running','completed') OR run_id IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS desktop_im_sessions (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','qq','wechat','telegram')),
      connection_id TEXT NOT NULL,
      session_id INTEGER NOT NULL UNIQUE,
      PRIMARY KEY(owner_id,platform,connection_id),
      FOREIGN KEY(session_id,owner_id) REFERENCES conversation_sessions(id,user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS desktop_im_delivery (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS desktop_im_notices (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      notice_key TEXT NOT NULL CHECK(length(notice_key) = 64),
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,notice_key),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS desktop_im_prompts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      prompt_id INTEGER NOT NULL REFERENCES interaction_prompts(id) ON DELETE CASCADE,
      message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('sending','accepted','unknown')),
      PRIMARY KEY(owner_id,platform,connection_id,prompt_id),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE,
      CHECK((state='accepted') = (message_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS ix_desktop_im_inbox_recovery
      ON desktop_im_inbox(owner_id,received_at) WHERE state IN ('pending','running');
    CREATE TRIGGER IF NOT EXISTS validate_desktop_im_inbox_owner_insert
      BEFORE INSERT ON desktop_im_inbox
      WHEN NEW.owner_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
    CREATE TRIGGER IF NOT EXISTS validate_desktop_im_inbox_owner_update
      BEFORE UPDATE OF owner_id ON desktop_im_inbox
      WHEN NEW.owner_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
  `)).immediate()
}
