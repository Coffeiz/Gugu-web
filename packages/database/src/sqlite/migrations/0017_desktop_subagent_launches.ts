import type SQLite from 'better-sqlite3'
import { subagentLaunchSchema } from '../../shared/subagent-launches.js'

export function initializeDesktopSubagentLaunches(db: SQLite.Database): void {
  db.transaction(() => db.exec(subagentLaunchSchema('BLOB'))).immediate()
}
