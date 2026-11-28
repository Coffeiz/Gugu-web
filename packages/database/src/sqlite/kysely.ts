import { CompiledQuery, Kysely, SqliteDialect, type Driver } from 'kysely'
import type SQLite from 'better-sqlite3'
import type { Database } from '../schema.js'

class ImmediateDialect extends SqliteDialect {
  override createDriver(): Driver {
    const backend = super.createDriver()
    backend.beginTransaction = async (connection) => {
      await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'))
    }
    return backend
  }
}

/** 原生 SQLite 句柄交给 Kysely。驱动未初始化时由 closeUnused 补齐关闭。 */
export function createSqliteKysely(database: SQLite.Database) {
  return {
    db: new Kysely<Database>({ dialect: new ImmediateDialect({ database }) }),
    closeUnused() {
      if (database.open) database.close()
    },
  }
}
