import type SQLite from 'better-sqlite3'
import { agentInboxSchema } from '../../shared/agent-inbox.js'

export function initializeDesktopAgentInbox(db: SQLite.Database): void {
  db.transaction(() => db.exec(agentInboxSchema('BLOB'))).immediate()
}
