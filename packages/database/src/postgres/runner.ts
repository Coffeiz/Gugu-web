import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { MigrationAction, MigrationStatus } from '../shared/command.js'

const ledger = 'gugu_schema_migrations'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class PostgresMigrationError extends Error {
  constructor(readonly code: 'incompatible' | 'unavailable', readonly revision?: string, cause?: unknown) {
    const message = code === 'incompatible' ? 'PostgreSQL 数据库迁移结构不兼容' : 'PostgreSQL 数据库迁移失败'
    super(revision ? `${message}（${revision}）` : message, { cause })
  }
}

interface PostgresMigrationDefinition {
  readonly revision: string
  readonly sql: string
  readonly tables: readonly string[]
  readonly indexes?: readonly string[]
  readonly prerequisites?: readonly string[]
  readonly downstreamIndexes?: readonly string[]
  readonly trackedFields?: readonly string[]
  readonly downstreamFields?: readonly string[]
  readonly functions?: readonly string[]
}

async function definitions(client: PoolClient, migration: PostgresMigrationDefinition): Promise<string> {
  const { rows } = await client.query<{ kind: string; name: string; detail: string }>(`
    WITH managed AS (
      SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND (c.relname=ANY($1::text[]) OR c.relname=ANY($7::text[]))
    )
    SELECT 'column' AS kind,m.relname||'.'||a.attname AS name,
      jsonb_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
        pg_get_expr(d.adbin,d.adrelid))::text AS detail
      FROM managed m JOIN pg_attribute a ON a.attrelid=m.oid
       LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
      WHERE a.attnum>0 AND NOT a.attisdropped
       AND (m.relname=ANY($1::text[]) OR m.relname||'.'||a.attname=ANY($5::text[]))
       AND NOT (m.relname||'.'||a.attname=ANY($6::text[]))
    UNION ALL
    SELECT 'constraint',m.relname||'.'||c.conname,
      jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text
      FROM managed m JOIN pg_constraint c ON c.conrelid=m.oid
      WHERE (m.relname=ANY($1::text[]) OR m.relname||'.'||c.conname=ANY($5::text[]))
        AND NOT (m.relname||'.'||c.conname=ANY($6::text[]))
    UNION ALL
    SELECT 'index',c.relname,jsonb_build_array(pg_get_indexdef(c.oid),i.indisvalid,i.indisready)::text
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND (i.indrelid IN (SELECT oid FROM managed WHERE relname=ANY($1::text[])) OR c.relname=ANY($2::text[]))
        AND NOT (c.relname=ANY($3::text[]))
    UNION ALL
    SELECT 'trigger',m.relname||'.'||t.tgname,
      jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM managed m JOIN pg_trigger t ON t.tgrelid=m.oid
      WHERE NOT t.tgisinternal AND m.relname=ANY($1::text[])
    UNION ALL
    SELECT 'function',p.proname,pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname=ANY($4::text[])
    ORDER BY kind,name,detail`, [
    migration.tables, migration.indexes ?? [], migration.downstreamIndexes ?? [], migration.functions ?? [],
    migration.trackedFields ?? [], migration.downstreamFields ?? [], (migration.trackedFields ?? []).map(field => field.split('.')[0]),
  ])
  return hash(JSON.stringify(rows))
}

async function inspect(client: PoolClient, migration: PostgresMigrationDefinition): Promise<'pending' | 'applied'> {
  const { revision, tables, indexes = [], prerequisites = [] } = migration
  const objects = [...tables, ...indexes]
  const { rows } = await client.query<{ name: string; matches: boolean; local: boolean }>(`
    SELECT name, to_regclass(name) IS NOT DISTINCT FROM
      to_regclass(format('%I.%I',current_schema(),name)) AS matches,
      to_regclass(format('%I.%I',current_schema(),name)) IS NOT NULL AS local
    FROM unnest($1::text[]) AS names(name)`, [[ledger, ...objects, ...prerequisites]])
  const present = new Map(rows.map(row => [row.name, row.local]))
  if (rows.some(row => !row.matches) || prerequisites.some(name => !present.get(name)))
    throw new PostgresMigrationError('incompatible', revision)
  const entry = present.get(ledger) && (await client.query<{ checksum: string; definition_hash: string }>(
    `SELECT checksum,definition_hash FROM ${ledger} WHERE revision=$1`, [revision],
  )).rows[0]
  if (!entry) {
    if (objects.some(name => present.get(name))) throw new PostgresMigrationError('incompatible', revision)
    return 'pending'
  }
  if (objects.some(name => !present.get(name)) || entry.checksum !== hash(migration.sql)
    || entry.definition_hash !== await definitions(client, migration))
    throw new PostgresMigrationError('incompatible', revision)
  return 'applied'
}

async function transaction<T>(
  pool: Pick<Pool, 'connect'>, action: MigrationAction, operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient
  try { client = await pool.connect() } catch (cause) { throw new PostgresMigrationError('unavailable', undefined, cause) }
  try {
    await client.query(action === 'check' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const scope = await client.query<{ schema: string | null }>('SELECT current_schema() AS schema')
    if (!scope.rows[0]?.schema) throw new PostgresMigrationError('incompatible')
    if (action === 'apply') {
      await client.query("SET LOCAL lock_timeout = '10s'")
      await client.query("SET LOCAL statement_timeout = '60s'")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':gugu-schema-migrations',0))")
    }
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (cause instanceof PostgresMigrationError) throw cause
    throw new PostgresMigrationError('unavailable', undefined, cause)
  } finally {
    client.release()
  }
}

export function definePostgresMigration(migration: PostgresMigrationDefinition) {
  const { revision, sql } = migration
  const checkIn = (client: PoolClient) => inspect(client, migration)
  async function applyIn(client: PoolClient): Promise<'applied' | 'unchanged'> {
    if (await checkIn(client) === 'applied') return 'unchanged'
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${ledger} (
        revision text PRIMARY KEY, checksum text NOT NULL, definition_hash text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      if (migration.functions?.length) {
        const { rows: [scope] } = await client.query<{ path: string }>("SELECT current_setting('search_path') AS path")
        await client.query("SELECT set_config('search_path',format('%I, pg_temp',current_schema()),true)")
        await client.query(sql)
        await client.query("SELECT set_config('search_path',$1,true)", [scope!.path])
      } else {
        await client.query(sql)
      }
      await client.query(`INSERT INTO ${ledger}(revision,checksum,definition_hash) VALUES ($1,$2,$3)`,
        [revision, hash(sql), await definitions(client, migration)])
    } catch (cause) {
      throw new PostgresMigrationError('unavailable', revision, cause)
    }
    return 'applied'
  }
  return {
    revision, checkIn, applyIn,
    check: (pool: Pick<Pool, 'connect'>) => transaction(pool, 'check', checkIn),
    apply: (pool: Pick<Pool, 'connect'>) => transaction(pool, 'apply', applyIn),
  }
}

export async function runPostgresMigrations(
  pool: Pick<Pool, 'connect'>, action: MigrationAction, catalog: readonly ReturnType<typeof definePostgresMigration>[],
): Promise<MigrationStatus> {
  return transaction(pool, action, async client => {
    const { rows: [scope] } = await client.query<{ local: boolean; matches: boolean }>(`SELECT
      to_regclass(format('%I.%I',current_schema(),$1::text)) IS NOT NULL AS local,
      to_regclass($1) IS NOT DISTINCT FROM to_regclass(format('%I.%I',current_schema(),$1)) AS matches`, [ledger])
    if (!scope?.matches) throw new PostgresMigrationError('incompatible')
    const recorded = scope?.local
      ? (await client.query<{ revision: string }>(`SELECT revision FROM ${ledger} ORDER BY revision`)).rows
      : []
    if (recorded.some(({ revision }, index) => revision !== catalog[index]?.revision))
      throw new PostgresMigrationError('incompatible')
    let applied = false
    for (const migration of catalog) {
      if (action === 'check') {
        if (await migration.checkIn(client) === 'pending') return 'pending'
      } else if (await migration.applyIn(client) === 'applied') {
        applied = true
      }
    }
    return action === 'apply' && !applied ? 'unchanged' : 'applied'
  })
}
