import type SQLite from 'better-sqlite3'
import { subagentSessionInboxIndexes } from '../../shared/subagent-deliveries.js'

export function initializeDesktopSubagentSessionInbox(db: SQLite.Database): void {
  db.exec(subagentSessionInboxIndexes)
}
