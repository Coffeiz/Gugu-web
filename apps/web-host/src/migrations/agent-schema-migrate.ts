import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class AgentSchemaMigrationError extends Error {
  constructor(readonly code: 'incompatible' | 'unavailable') {
    super(code === 'incompatible' ? 'Agent 数据库迁移结构不兼容' : 'Agent 数据库迁移不可用')
  }
}

interface AgentSchemaMigration {
  readonly ledger: string
  readonly revision: string
  readonly sql: string
  readonly tables: readonly string[]
  readonly indexes?: readonly string[]
  readonly prerequisites?: readonly string[]
  readonly downstreamIndexes?: readonly string[]
  readonly functions?: readonly string[]
  /** 允许先验结构匹配的既有业务表由 Node 迁移登记接管，不转换或丢弃行。 */
  readonly adoptExisting?: (client: PoolClient) => Promise<boolean>
  readonly lockKey: string
}

async function definitions(client: PoolClient, migration: AgentSchemaMigration): Promise<string> {
  const { rows } = await client.query<{ kind: string; name: string; detail: string }>(`
    WITH managed AS (
      SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])
    )
    SELECT 'column' AS kind,m.relname||'.'||a.attname AS name,
      jsonb_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
        pg_get_expr(d.adbin,d.adrelid))::text AS detail
      FROM managed m JOIN pg_attribute a ON a.attrelid=m.oid
       LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
      WHERE a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint',m.relname||'.'||c.conname,
      jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated)::text
      FROM managed m JOIN pg_constraint c ON c.conrelid=m.oid
    UNION ALL
    SELECT 'index',c.relname,jsonb_build_array(pg_get_indexdef(c.oid),i.indisvalid,i.indisready)::text
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND (i.indrelid IN (SELECT oid FROM managed) OR c.relname=ANY($2::text[]))
        AND NOT (c.relname=ANY($3::text[]))
    UNION ALL
    SELECT 'trigger',m.relname||'.'||t.tgname,
      jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
      FROM managed m JOIN pg_trigger t ON t.tgrelid=m.oid
      WHERE NOT t.tgisinternal AND cardinality($4::text[])>0
    UNION ALL
    SELECT 'function',p.proname,pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema() AND p.proname=ANY($4::text[])
    ORDER BY kind,name,detail`, [
    [migration.ledger, ...migration.tables], migration.indexes ?? [], migration.downstreamIndexes ?? [], migration.functions ?? [],
  ])
  return hash(JSON.stringify(rows))
}

async function inspect(client: PoolClient, migration: AgentSchemaMigration): Promise<'pending' | 'applied'> {
  const { ledger, revision, tables, indexes = [], prerequisites = [] } = migration
  const objects = [...tables, ...indexes]
  const names = [ledger, ...objects, ...prerequisites]
  const { rows } = await client.query<{ name: string; matches: boolean; local: boolean }>(`
    SELECT name,CASE WHEN current_schema() IS NULL THEN false
      ELSE to_regclass(name) IS NOT DISTINCT FROM to_regclass(format('%I.%I',current_schema(),name)) END AS matches,
      CASE WHEN current_schema() IS NULL THEN false
        ELSE to_regclass(format('%I.%I',current_schema(),name)) IS NOT NULL END AS local
    FROM unnest($1::text[]) AS names(name)`, [names])
  const present = new Map(rows.map(row => [row.name, row.local]))
  if (rows.some(row => !row.matches) || prerequisites.some(name => !present.get(name)))
    throw new AgentSchemaMigrationError('incompatible')
  if (!present.get(ledger)) {
    if (objects.some(name => present.get(name))) {
      if (!migration.adoptExisting || !await migration.adoptExisting(client))
        throw new AgentSchemaMigrationError('incompatible')
    }
    return 'pending'
  }
  if (objects.some(name => !present.get(name))) throw new AgentSchemaMigrationError('incompatible')
  const { rows: records } = await client.query<{ revision: string; checksum: string; definition_hash: string }>(
    `SELECT revision,checksum,definition_hash FROM ${ledger}`)
  const entry = records[0]
  if (records.length !== 1 || entry?.revision !== revision || entry.checksum !== hash(migration.sql)
    || entry.definition_hash !== await definitions(client, migration))
    throw new AgentSchemaMigrationError('incompatible')
  return 'applied'
}

async function migrationTransaction<T>(pool: Pick<Pool, 'connect'>, mode: 'read' | 'write', operation: (client: PoolClient) => Promise<T>) {
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new AgentSchemaMigrationError('unavailable') }
  try {
    await client.query(mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof AgentSchemaMigrationError) throw error
    throw new AgentSchemaMigrationError('unavailable')
  } finally { client.release() }
}

export function createAgentSchemaMigration(migration: AgentSchemaMigration) {
  const { ledger, revision, sql, lockKey } = migration
  return {
    check(pool: Pick<Pool, 'connect'>) {
      return migrationTransaction(pool, 'read', client => inspect(client, migration))
    },
    apply(pool: Pick<Pool, 'connect'>): Promise<'applied' | 'unchanged'> {
      return migrationTransaction(pool, 'write', async client => {
        await client.query("SET LOCAL lock_timeout = '10s'")
        await client.query("SET LOCAL statement_timeout = '60s'")
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || $1,0))", [lockKey])
        if (await inspect(client, migration) === 'applied') return 'unchanged'
        if (migration.functions?.length) {
          await client.query("SELECT set_config('search_path',format('%I, pg_temp',current_schema()),true)")
        }
        await client.query(sql)
        await client.query(`CREATE TABLE ${ledger} (
          revision text PRIMARY KEY, checksum text NOT NULL, definition_hash text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`)
        await client.query(`INSERT INTO ${ledger}(revision,checksum,definition_hash) VALUES ($1,$2,$3)`,
          [revision, hash(sql), await definitions(client, migration)])
        if (await inspect(client, migration) !== 'applied') throw new AgentSchemaMigrationError('incompatible')
        return 'applied'
      })
    },
  }
}
