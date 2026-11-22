import type SQLite from 'better-sqlite3'
import { subagentConversationSchema } from '../../shared/subagent-conversations.js'

export function initializeDesktopSubagentConversations(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentConversationSchema('lower(hex(randomblob(4)))'))).immediate()
}
