import { createHash } from 'node:crypto'
import {
  DummyDriver, Kysely, PostgresDialect, SqliteDialect, type CompiledQuery,
} from 'kysely'
import type { Database } from '../schema.js'

export type MigrationEngine = 'postgres' | 'sqlite'
type Build = (db: Kysely<Database>) => readonly { compile(): CompiledQuery }[]

export interface LogicalMigration {
  readonly id: string
  readonly targets: readonly MigrationEngine[]
  readonly prerequisites?: readonly string[]
  readonly tables?: readonly string[]
  /** 首次应用时必须尚不存在的对象；用于仅修改基线表字段的迁移。 */
  readonly createdObjects?: readonly string[]
  readonly indexes?: readonly string[]
  readonly triggers?: readonly string[]
  readonly build: Build
  readonly after?: Partial<Record<MigrationEngine, Build>>
}

class PostgresCompiler extends PostgresDialect {
  override createDriver() { return new DummyDriver() }
}

class SqliteCompiler extends SqliteDialect {
  override createDriver() { return new DummyDriver() }
}

const compilers = {
  postgres: new Kysely<Database>({ dialect: new PostgresCompiler({
    async pool() { throw new Error('迁移构建阶段不能连接数据库') },
  }) }),
  sqlite: new Kysely<Database>({ dialect: new SqliteCompiler({
    async database() { throw new Error('迁移构建阶段不能连接数据库') },
  }) }),
}

export function compileLogicalMigrations(engine: MigrationEngine, catalog: readonly LogicalMigration[]) {
  for (const [index, item] of catalog.entries()) {
    if (!/^[0-9]{4}_[a-z0-9_]+$/u.test(item.id) || !item.targets.length
      || index > 0 && catalog[index - 1]!.id >= item.id)
      throw new Error('逻辑迁移编号或顺序无效')
  }
  const db = compilers[engine]
  return catalog.filter(item => item.targets.includes(engine)).map(item => {
    const statements = [...item.build(db), ...(item.after?.[engine]?.(db) ?? [])].map(query => query.compile())
    const checksumInput = JSON.stringify(statements.map(({ sql, parameters }) => [sql, parameters]))
    return { ...item, statements, checksumInput, checksum: createHash('sha256').update(checksumInput).digest('hex') }
  })
}
