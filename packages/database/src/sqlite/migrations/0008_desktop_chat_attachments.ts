import type SQLite from 'better-sqlite3'

/** 本机聊天附件元数据；附件正文存放在受控的 userData/agent-attachments 目录。 */
export function initializeDesktopChatAttachments(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      attach_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      mime TEXT,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size >= 0),
      duration REAL,
      img_width INTEGER,
      img_height INTEGER,
      state TEXT NOT NULL CHECK(state IN ('draft','attached')),
      extra TEXT,
      created_at TEXT NOT NULL,
      attached_at TEXT,
      PRIMARY KEY(user_id,attach_id),
      CHECK(length(attach_id)=32 AND attach_id NOT GLOB '*[^0-9a-f]*'),
      CHECK(storage_key='agent-attachments/' || attach_id)
    );
    CREATE INDEX IF NOT EXISTS ix_chat_attachments_owner_state ON chat_attachments(user_id,state);
    CREATE INDEX IF NOT EXISTS ix_chat_attachments_message ON chat_attachments(user_id,message_id);
    CREATE TRIGGER IF NOT EXISTS validate_chat_attachments_owner_insert
      BEFORE INSERT ON chat_attachments
      WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
    CREATE TRIGGER IF NOT EXISTS validate_chat_attachments_owner_update
      BEFORE UPDATE OF user_id ON chat_attachments
      WHEN NEW.user_id IS NOT (SELECT lower(replace(value,'-','')) FROM core_runtime_meta WHERE key='owner_id')
      BEGIN SELECT RAISE(ABORT, 'owner 不匹配'); END;
  `)).immediate()
}
