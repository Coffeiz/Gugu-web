import type { Pool, PoolClient } from 'pg'
import { AGENT_SNAPSHOT_CHECKSUM, AGENT_SNAPSHOT_REVISION, AGENT_SNAPSHOT_SQL } from './agent-snapshot-schema.js'

const ledger = 'gugu_node_schema_migrations'
const expectedObjects = ['gugu_agent_snapshot_manifest','gugu_agent_snapshot_chunks']
export class AgentSnapshotMigrationError extends Error {
  constructor(readonly code: 'incompatible' | 'unavailable') { super(code === 'incompatible' ? 'Node 迁移状态不兼容' : 'Node 迁移操作失败') }
}
async function inspect(client: PoolClient): Promise<'pending' | 'applied'> {
  const scope = await client.query<{ valid: boolean }>(`SELECT current_schema() IS NOT NULL AND bool_and(to_regclass(name) IS NOT DISTINCT FROM to_regclass(format('%I.%I',current_schema(),name))) AS valid FROM unnest($1::text[]) AS names(name)`, [['alembic_version','agent_run_dispatch','conversation_sessions','conversation_messages',ledger,...expectedObjects]])
  if (!scope.rows[0]?.valid) throw new AgentSnapshotMigrationError('incompatible')
  const revision = await client.query<{ version_num: string }>('SELECT version_num FROM alembic_version')
  if (revision.rows.length !== 1 || !['20261115000004','20261115000005','20261115000006','20261115000007'].includes(revision.rows[0]!.version_num)) throw new AgentSnapshotMigrationError('incompatible')
  const prerequisite = await client.query(`SELECT d.user_id,d.session_id,d.run_id,d.message_id,s.id,s.user_id,m.id,m.session_id,m.role FROM agent_run_dispatch d JOIN conversation_sessions s ON false JOIN conversation_messages m ON false LIMIT 0`)
  void prerequisite
  const relation = await client.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [ledger])
  if (!relation.rows[0]?.name) {
    const objects = await client.query<{ name: string | null }>('SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) AS name', [expectedObjects])
    if (objects.rows.some(row => row.name !== null)) throw new AgentSnapshotMigrationError('incompatible')
    return 'pending'
  }
  const rows = await client.query<{ revision: string; checksum: string }>('SELECT revision,checksum FROM gugu_node_schema_migrations ORDER BY revision')
  if (rows.rows.length !== 1 || rows.rows[0]?.revision !== AGENT_SNAPSHOT_REVISION || rows.rows[0]?.checksum !== AGENT_SNAPSHOT_CHECKSUM) throw new AgentSnapshotMigrationError('incompatible')
  const objects = await client.query<{ name: string | null }>('SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) AS name', [expectedObjects])
  if (objects.rows.length !== expectedObjects.length || objects.rows.some(row => row.name === null)) throw new AgentSnapshotMigrationError('incompatible')
  const columns = await client.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; character_maximum_length: number | null; column_default: string | null }>(`SELECT table_name,column_name,data_type,is_nullable,character_maximum_length,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`, [[ledger,...expectedObjects]])
  const required: Record<string, string[]> = {
    [ledger]: ['revision:text:NO','checksum:text:NO','applied_at:timestamp with time zone:NO'],
    gugu_agent_snapshot_manifest: ['user_id:uuid:NO','session_id:integer:NO','run_id:character varying:NO','message_id:integer:NO','codec_version:integer:NO','key_version:integer:NO','wrapped_key:bytea:NO','chunk_count:bigint:NO','total_bytes:bigint:NO','digest:bytea:NO','created_at:timestamp with time zone:NO'],
    gugu_agent_snapshot_chunks: ['user_id:uuid:NO','session_id:integer:NO','run_id:character varying:NO','message_id:integer:NO','ordinal:bigint:NO','nonce:bytea:NO','ciphertext:bytea:NO'],
  }
  for (const [table, expected] of Object.entries(required)) {
    const actual = columns.rows.filter(row => row.table_name === table).map(row => `${row.column_name}:${row.data_type}:${row.is_nullable}`)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new AgentSnapshotMigrationError('incompatible')
    for (const row of columns.rows.filter(item => item.table_name === table)) {
      if (row.character_maximum_length !== (row.column_name === 'run_id' ? 128 : null)) throw new AgentSnapshotMigrationError('incompatible')
      const expectedDefault = (table === ledger && row.column_name === 'applied_at') || (table === 'gugu_agent_snapshot_manifest' && row.column_name === 'created_at') ? 'CURRENT_TIMESTAMP' : null
      if (row.column_default !== expectedDefault) throw new AgentSnapshotMigrationError('incompatible')
    }
  }
  const constraints = await client.query<{ name: string; definition: string; validated: boolean }>(`SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS definition,c.convalidated AS validated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname=ANY($1::text[])`, [[ledger,...expectedObjects]])
  if (constraints.rows.length !== 8 || constraints.rows.some(row => !row.validated)) throw new AgentSnapshotMigrationError('incompatible')
  const defs = new Map(constraints.rows.map(row => [row.name,row.definition]))
  for (const [name,pattern] of [
    ['gugu_node_schema_migrations_pkey', /^PRIMARY KEY \(revision\)$/],
    ['gugu_agent_snapshot_manifest_pkey', /^PRIMARY KEY \(user_id, session_id, run_id, message_id\)$/],
    ['gugu_agent_snapshot_chunks_pkey', /^PRIMARY KEY \(user_id, session_id, run_id, message_id, ordinal\)$/],
    ['gugu_agent_snapshot_manifest_chunk_count_check', /^CHECK \(\(chunk_count >= (?:0|0::bigint)\)\)$/],
    ['gugu_agent_snapshot_manifest_total_bytes_check', /^CHECK \(\(total_bytes >= (?:0|0::bigint)\)\)$/],
    ['gugu_agent_snapshot_chunks_ordinal_check', /^CHECK \(\(ordinal >= (?:0|0::bigint)\)\)$/],
    ['gugu_snapshot_manifest_dispatch_fk', /^FOREIGN KEY \(user_id, session_id, run_id\) REFERENCES (?:[^ ]+\.)?agent_run_dispatch\(user_id, session_id, run_id\) ON DELETE CASCADE$/],
    ['gugu_snapshot_chunks_manifest_fk', /^FOREIGN KEY \(user_id, session_id, run_id, message_id\) REFERENCES (?:[^ ]+\.)?gugu_agent_snapshot_manifest\(user_id, session_id, run_id, message_id\) ON DELETE CASCADE$/],
  ] as const) if (!pattern.test(defs.get(name) ?? '')) throw new AgentSnapshotMigrationError('incompatible')
  return 'applied'
}
/** 只读检查；首次不存在台账时也不会创建任何对象。 */
export async function checkAgentSnapshotMigration(pool: Pick<Pool, 'connect'>): Promise<'pending' | 'applied'> {
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new AgentSnapshotMigrationError('unavailable') }
  try {
    await client.query('BEGIN READ ONLY')
    const result = await inspect(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof AgentSnapshotMigrationError) throw error
    throw new AgentSnapshotMigrationError('unavailable')
  } finally { client.release() }
}
/** 仅显式调用；一次事务涵盖台账与 DDL。 */
export async function applyAgentSnapshotMigration(pool: Pick<Pool, 'connect'>): Promise<'applied' | 'unchanged'> {
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new AgentSnapshotMigrationError('unavailable') }
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '10s'")
    await client.query("SET LOCAL statement_timeout = '60s'")
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1196779349, 1095980112])
    if (await inspect(client) === 'applied') { await client.query('COMMIT'); return 'unchanged' }
    await client.query('CREATE TABLE gugu_node_schema_migrations (revision text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    await client.query(AGENT_SNAPSHOT_SQL)
    await client.query('INSERT INTO gugu_node_schema_migrations(revision,checksum) VALUES ($1,$2)', [AGENT_SNAPSHOT_REVISION, AGENT_SNAPSHOT_CHECKSUM])
    if (await inspect(client) !== 'applied') throw new AgentSnapshotMigrationError('incompatible')
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof AgentSnapshotMigrationError) throw error
    throw new AgentSnapshotMigrationError('unavailable')
  } finally { client.release() }
}
