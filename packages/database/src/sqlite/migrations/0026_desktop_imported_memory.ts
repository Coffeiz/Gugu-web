import type SQLite from 'better-sqlite3'

/** 让已存在的记忆待落盘队列承载归档中的完整个人记忆正文。 */
export function initializeDesktopImportedMemory(db: SQLite.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_imported_im_memory (
    owner_id TEXT NOT NULL, platform TEXT NOT NULL, bot_id TEXT NOT NULL, scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL, filename TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(owner_id,platform,bot_id,scope_type,scope_id,filename)
  )`)
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='desktop_agent_memory_documents'").get() as { sql: string }
  if (schema.sql.includes("'memory'")) return
  db.transaction(() => db.exec(`
    CREATE TABLE desktop_agent_memory_documents_next (
      user_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('summary', 'daily', 'stance', 'lens', 'memory')),
      body TEXT NOT NULL,
      PRIMARY KEY(user_id, target)
    );
    INSERT INTO desktop_agent_memory_documents_next SELECT user_id,target,body FROM desktop_agent_memory_documents;
    DROP TABLE desktop_agent_memory_documents;
    ALTER TABLE desktop_agent_memory_documents_next RENAME TO desktop_agent_memory_documents;
  `))()
}
