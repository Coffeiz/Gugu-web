import { tablesSql } from '@gugu/core/data'
import type { Pool } from 'pg'
import { withPostgresTransaction } from '../adapters/database/postgres-transaction.js'
import { AgentSchemaMigrationError } from './agent-schema-migrate.js'

const storage = [
  ['core_operation_receipts', `${tablesSql('postgres').receipts};
    ALTER TABLE core_operation_receipts ADD FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE`],
  ['project_undo_journals', `CREATE TABLE project_undo_journals (
    id uuid PRIMARY KEY, user_id uuid NOT NULL, operation_id varchar(64) NOT NULL,
    before_status varchar(16) NOT NULL, after_status varchar(16) NOT NULL,
    moves json NOT NULL, created_at timestamptz NOT NULL,
    CONSTRAINT uq_project_undo_journal_operation UNIQUE (user_id, operation_id)
  )`],
] as const

/** 为已建成业务表的旧测试库补齐 Agent 项目修改所需的存储。 */
export async function applyProjectToolsMigration(pool: Pick<Pool, 'connect'>): Promise<'applied' | 'unchanged'> {
  return withPostgresTransaction(pool, async client => {
    await client.query("SET LOCAL lock_timeout = '10s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':gugu-project-tools-schema', 0))")
    const { rows } = await client.query<{ name: string; local: boolean; matches: boolean }>(`
      SELECT name, to_regclass(format('%I.%I', current_schema(), name)) IS NOT NULL AS local,
        to_regclass(name) IS NOT DISTINCT FROM to_regclass(format('%I.%I', current_schema(), name)) AS matches
      FROM unnest($1::text[]) AS names(name)`, [['users', 'projects', 'undo_operations', ...storage.map(([name]) => name)]])
    if (rows.some(row => !row.matches || (!row.local && !storage.some(([name]) => name === row.name))))
      throw new AgentSchemaMigrationError('incompatible')
    const missing = storage.filter(([name]) => rows.some(row => row.name === name && !row.local))
    for (const [, sql] of missing) await client.query(sql)
    return missing.length ? 'applied' : 'unchanged'
  })
}
