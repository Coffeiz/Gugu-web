import type SQLite from 'better-sqlite3'
import { subagentSessionSchema } from '../../shared/subagent-sessions.js'

export function initializeDesktopSubagentSessions(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentSessionSchema)).immediate()
}
