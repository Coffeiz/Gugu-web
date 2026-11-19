import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'

export async function loadSqliteDriver(): Promise<typeof SQLite> {
  try {
    return (await import('better-sqlite3')).default
  } catch {
    throw new DatabaseError('storage_error', 'SQLite 驱动不可用，请检查匹配的运行时制品')
  }
}

export function configureSqlite(db: SQLite.Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
}
