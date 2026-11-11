import { Kysely, PostgresDialect } from 'kysely'
import { CoreError } from '../contracts/index.js'
import { SqlDataRuntime } from './runtime.js'
import type { Database } from './schema.js'
import type { Clock } from './codec.js'

export async function createPostgresRuntime(config: { url: string; schema?: string; maxConnections?: number; clock?: Clock }): Promise<SqlDataRuntime> {
  try { if (!['postgres:', 'postgresql:'].includes(new URL(config.url).protocol)) throw new Error() } catch { throw new CoreError('invalid_request', 'PostgreSQL 连接格式无效') }
  if (config.schema && !/^[a-z][a-z0-9_]*$/.test(config.schema)) throw new CoreError('invalid_request', '数据库 schema 名称无效')
  const maximum = config.maxConnections ?? 15
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new CoreError('invalid_request', '连接池参数无效')
  const pg = await import('pg')
  const pool = new pg.Pool({ connectionString: config.url, max: maximum, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
    options: `-c timezone=UTC -c idle_in_transaction_session_timeout=60000${config.schema ? ` -c search_path=${config.schema}` : ''}`,
    types: { getTypeParser: (oid: number, format?: 'text' | 'binary') => [1114, 1184].includes(oid) && format !== 'binary' ? (value: string) => value : pg.types.getTypeParser(oid, format) },
  })
  return new SqlDataRuntime(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), 'postgres', config.clock)
}
