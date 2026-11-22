import type SQLite from 'better-sqlite3'
import { subagentExecutionMigration } from '../../shared/subagent-executions.js'

export function initializeDesktopSubagentExecutions(db: SQLite.Database): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_subagent_executions'").get()) return
    db.exec(subagentExecutionMigration('BLOB'))
  }).immediate()
}
