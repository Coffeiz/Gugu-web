import { migrateSqliteLogical } from './logical-migrations.js'
export { migrateSqliteLogical } from './logical-migrations.js'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type SQLite from 'better-sqlite3'
import { DatabaseError } from '../shared/error.js'
import { configureSqlite, loadSqliteDriver } from './driver.js'
import type { MigrationAction, MigrationStatus } from '../shared/command.js'
import { initializeSchema } from '../migrations/baseline/sqlite.js'
import { validateSqliteBaseline } from './validate.js'

async function createDatabase(path: string): Promise<boolean> {
  const target = resolve(path),
    parent = dirname(target),
    Driver = await loadSqliteDriver()
  if (existsSync(target)) return false
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, '.core-initialize-')),
    temporary = join(directory, 'core.db')
  let db: SQLite.Database | undefined
  try {
    closeSync(openSync(temporary, 'wx', 0o600))
    db = new Driver(temporary)
    configureSqlite(db)
    if (db.pragma('journal_mode = WAL', { simple: true }) !== 'wal')
      throw new DatabaseError('storage_error', '本地数据库无法启用 WAL')
    db.exec('BEGIN IMMEDIATE')
    initializeSchema(db)
    validateSqliteBaseline(db)
    migrateSqliteLogical(db, 'apply')
    db.exec('COMMIT')
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    // 完整文件发布前目标不可见；硬链接不覆盖已出现的用户文件。
    try { linkSync(temporary, target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } finally {
    db?.close()
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(temporary + suffix)) unlinkSync(temporary + suffix)
    rmdirSync(directory)
  }
}
export async function initializeSqlite(path: string): Promise<void> {
  if (!await createDatabase(path)) throw new DatabaseError('storage_error', '数据库已存在，已拒绝覆盖')
}

export async function migrateSqlite(path: string, action: MigrationAction): Promise<MigrationStatus> {
  const target = resolve(path)
  if (action === 'apply' && await createDatabase(target)) return 'applied'
  if (!existsSync(target)) return 'pending'
  const Driver = await loadSqliteDriver()
  const db = new Driver(target, { readonly: action === 'check', fileMustExist: true })
  try {
    validateSqliteBaseline(db)
    return migrateSqliteLogical(db, action)
  } finally {
    db.close()
  }
}
