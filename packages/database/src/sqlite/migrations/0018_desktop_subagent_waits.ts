import type SQLite from 'better-sqlite3'
import { subagentWaitSchema } from '../../shared/subagent-waits.js'

export function initializeDesktopSubagentWaits(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentWaitSchema)).immediate()
}
