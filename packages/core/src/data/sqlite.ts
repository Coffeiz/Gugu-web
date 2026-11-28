import { createSqliteKysely } from '@gugu/database/sqlite/kysely'
import { resolve } from 'node:path'
import { DatabaseError } from '@gugu/database/error'
import { migrateSqliteLogical, initializeSqlite as initialize, migrateSqlite as migrate } from '@gugu/database/sqlite'
import { configureSqlite, loadSqliteDriver } from '@gugu/database/sqlite/driver'
import { validateSqliteBaseline } from '@gugu/database/sqlite/validate'
import { CoreError } from '../contracts/index.js'
import type { Clock } from './codec.js'
import { SqlDataRuntime } from './runtime.js'

function toCoreSqliteError(error: unknown): never {
  throw error instanceof DatabaseError ? new CoreError(error.code, error.message) : error
}

export function initializeSqlite(...args: Parameters<typeof initialize>): ReturnType<typeof initialize> {
  return initialize(...args).catch(toCoreSqliteError)
}

export function migrateSqlite(...args: Parameters<typeof migrate>): ReturnType<typeof migrate> {
  return migrate(...args).catch(toCoreSqliteError)
}

export async function openSqliteRuntime(
  path: string,
  options: {
    clock?: Clock
    exclusive?: boolean
  } = {},
): Promise<{
  runtime: SqlDataRuntime
  ownerId: string
  schemaVersion: string
}> {
  const Driver = await loadSqliteDriver().catch(toCoreSqliteError),
    db = new Driver(resolve(path), { fileMustExist: true })
  try {
    configureSqlite(db)
    if (options.exclusive) {
      try {
        db.pragma('locking_mode = EXCLUSIVE')
        db.exec('BEGIN EXCLUSIVE; COMMIT')
      } catch {
        throw new CoreError('database_in_use', '数据库正由其他运行时使用，请先关闭其他实例')
      }
    }
    const info = validateSqliteBaseline(db)
    migrateSqliteLogical(db, 'apply')
    const storage = createSqliteKysely(db)
    const runtime = new SqlDataRuntime(storage.db, 'sqlite', options.clock, true, storage.closeUnused)
    return { runtime, ownerId: info.owner, schemaVersion: info.version }
  } catch (error) {
    db.close()
    toCoreSqliteError(error)
  }
}
