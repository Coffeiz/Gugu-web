import type SQLite from 'better-sqlite3'
import { subagentContinuationSchema } from '../../shared/subagent-continuations.js'

export function initializeDesktopSubagentContinuations(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentContinuationSchema('BLOB'))).immediate()
}
