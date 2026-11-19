import { CompiledQuery, Kysely, SqliteDialect } from 'kysely'
import type { Driver } from 'kysely'
import { resolve } from 'node:path'
import { DatabaseError } from '@gugu/database/error'
import { initializeSqlite as initialize, migrateSqlite as migrate } from '@gugu/database/sqlite'
import { configureSqlite, loadSqliteDriver } from '@gugu/database/sqlite/driver'
import { validateSqliteBaseline } from '@gugu/database/sqlite/validate'
import { CoreError } from '../contracts/index.js'
import type { Clock } from './codec.js'
import { SqlDataRuntime } from './runtime.js'
import type { Database } from './schema.js'

function toCoreSqliteError(error: unknown): never {
  throw error instanceof DatabaseError ? new CoreError(error.code, error.message) : error
}

export function initializeSqlite(...args: Parameters<typeof initialize>): ReturnType<typeof initialize> {
  return initialize(...args).catch(toCoreSqliteError)
}

export function migrateSqlite(...args: Parameters<typeof migrate>): ReturnType<typeof migrate> {
  return migrate(...args).catch(toCoreSqliteError)
}

class ImmediateDialect extends SqliteDialect {
  override createDriver(): Driver {
    const backend = super.createDriver()
    backend.beginTransaction = async (connection) => {
      await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'))
    }
    return backend
  }
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
    // Kysely 驱动延迟初始化；从未查询也要关闭预先打开的原生句柄。
    const runtime = new SqlDataRuntime(
      new Kysely<Database>({ dialect: new ImmediateDialect({ database: db }) }),
      'sqlite',
      options.clock,
      true,
      () => {
        if (db.open) db.close()
      },
    )
    return { runtime, ownerId: info.owner, schemaVersion: info.version }
  } catch (error) {
    db.close()
    toCoreSqliteError(error)
  }
}
