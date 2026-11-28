import assert from 'node:assert/strict'
import { createAgentSessionRefresh, createSqlAgentSessionRefreshRepository } from '../../../src/agent/sessions/refresh.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

export const clock = () => '2026-11-14T12:00:00.123456Z'
export async function check(runtime: SqlDataRuntime, owner: string, other: string) {
  const db = runtime.db.withTables<{ conversation_sessions: { id: number; user_id: string; context_epoch: number; session_context: string; snapshot_hash: string; session_info_hash: string; snapshot_expires_at: string; updated_at: string } }>()
  await db.schema.createTable('conversation_sessions').addColumn('id', 'integer', c => c.primaryKey()).addColumn('user_id', runtime.backend === 'postgres' ? 'uuid' : 'text', c => c.notNull()).addColumn('context_epoch', 'integer', c => c.notNull()).addColumn('session_context', runtime.backend === 'postgres' ? 'jsonb' : 'text', c => c.notNull()).addColumn('snapshot_hash', 'text').addColumn('session_info_hash', 'text').addColumn('snapshot_expires_at', runtime.backend === 'postgres' ? 'timestamptz' : 'text').addColumn('updated_at', runtime.backend === 'postgres' ? 'timestamptz' : 'text', c => c.notNull()).execute()
  const key = (value: string) => runtime.backend === 'sqlite' ? value.replaceAll('-', '') : value
  await db.insertInto('conversation_sessions').values([{ id: 1, user_id: key(owner), context_epoch: 1, session_context: runtime.backend === 'postgres' ? JSON.stringify('private-synthetic') : 'private-synthetic', snapshot_hash: 'snapshot', session_info_hash: 'info', snapshot_expires_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }, { id: 2, user_id: key(other), context_epoch: 7, session_context: runtime.backend === 'postgres' ? JSON.stringify('other') : 'other', snapshot_hash: 'other', session_info_hash: 'other', snapshot_expires_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }]).execute()
  const refresh = createAgentSessionRefresh(createSqlAgentSessionRefreshRepository(runtime.db, runtime.backend, clock))
  assert.equal(await refresh(owner, 2), null)
  const results = await Promise.all(Array.from({ length: 6 }, () => refresh(owner, 1)))
  assert.deepEqual(results.map(row => row!.contextEpoch).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7])
  assert.ok(results.every(row => row!.snapshotHash === 'snapshot' && row!.sessionInfoHash === 'info'))
  assert.ok(results.every(row => row!.expiresAt === '2026-11-14T12:00:00.123456Z'))
  const rows = await db.selectFrom('conversation_sessions').selectAll().orderBy('id').execute()
  assert.equal(rows[0]!.session_context, 'private-synthetic'); assert.equal(rows[0]!.context_epoch, 7)
  assert.match(String(rows[0]!.snapshot_expires_at), /^2026-11-14 12:00:00\.123456/)
  assert.match(String(rows[0]!.updated_at), /^2026-11-14 12:00:00\.123456/)
  assert.equal(rows[1]!.context_epoch, 7); assert.match(String(rows[1]!.snapshot_expires_at), /^2026-01-01/)
}
