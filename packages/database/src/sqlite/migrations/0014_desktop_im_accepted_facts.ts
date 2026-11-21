import type SQLite from 'better-sqlite3'

/** 只保存平台已接受回复的消息 ID 与既有 assistant 消息关联，不复制正文。 */
export function initializeDesktopImAcceptedFacts(db: SQLite.Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS desktop_im_accepted_facts (
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('feishu','telegram')),
      connection_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
      platform_message_id TEXT NOT NULL CHECK(length(platform_message_id) BETWEEN 1 AND 512),
      recipient_sender_id TEXT NOT NULL CHECK(length(recipient_sender_id) BETWEEN 1 AND 256),
      sent_at_ms INTEGER NOT NULL CHECK(sent_at_ms > 0),
      source_attention_kind TEXT CHECK(source_attention_kind IS NULL OR source_attention_kind IN
        ('DIRECT','member_CONTINUE','CAPABILITY_ACTION','member_ACTIVE','proactive','autonomous')),
      PRIMARY KEY(owner_id,platform,connection_id,event_key,platform_message_id),
      FOREIGN KEY(owner_id,platform,connection_id,event_key)
        REFERENCES desktop_im_inbox(owner_id,platform,connection_id,event_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_desktop_im_accepted_facts_scope_time
      ON desktop_im_accepted_facts(owner_id,platform,connection_id,sent_at_ms);
  `)).immediate()
}
