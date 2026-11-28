import { Kysely, PostgresDialect, type PostgresDialectConfig } from 'kysely'
import type * as Pg from 'pg'
import type { Database } from '../schema.js'
import { createPostgresPool } from './pool.js'
import { DatabaseError } from '../shared/error.js'

/** Kysely 驱动拥有传入池的生命周期。借用连接应提供不关闭外层池的适配器。 */
export function createPostgresKysely(pool: PostgresDialectConfig['pool']): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

export function openPostgresKysely(pg: Pick<typeof Pg, 'Pool' | 'types'>,
  config: { url: string; schema?: string; maxConnections?: number }): Kysely<Database> {
  try {
    if (!['postgres:', 'postgresql:'].includes(new URL(config.url).protocol)) throw new Error()
  } catch {
    throw new DatabaseError('invalid_request', 'PostgreSQL 连接格式无效')
  }
  if (config.schema && !/^[a-z][a-z0-9_]*$/.test(config.schema))
    throw new DatabaseError('invalid_request', '数据库 schema 名称无效')
  const maximum = config.maxConnections ?? 15
  if (!Number.isSafeInteger(maximum) || maximum < 1)
    throw new DatabaseError('invalid_request', '连接池参数无效')
  // Kysely 延迟初始化，首次查询前无需创建连接池。
  return createPostgresKysely(async () => createPostgresPool(pg.Pool, {
    connectionString: config.url,
    max: maximum,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    options: `-c timezone=UTC -c idle_in_transaction_session_timeout=60000${config.schema ? ` -c search_path=${config.schema}` : ''}`,
    types: {
      getTypeParser: (oid: number, format?: 'text' | 'binary') =>
        [1114, 1184].includes(oid) && format !== 'binary'
          ? (value: string) => value
          : pg.types.getTypeParser(oid, format),
    },
  }))
}
