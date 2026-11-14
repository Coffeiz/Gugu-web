import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresMindRefNodeCreateRuntime } from '../../src/domains/mind/persistence/mind-ref-node-create-postgres.js'

const now = new Date('2026-11-14T01:02:03.000Z')

test('PostgreSQL reference-node adapter returns a numeric id when bigint is returned as text', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('FROM projects')) return { rows: [{
        name: '星尘计划', color: null, client: null, status: 'active',
        start_date: null, deadline: null, done_at: null,
      }] }
      if (sql.includes('FROM mind_nodes')) return { rows: [] }
      if (sql.includes('INSERT INTO mind_nodes')) return { rows: [{
        id: '42', kind: 'ref', title: '星尘计划', content_md: '', content_plain: '', color: null,
        captured_at: now, version: 1, created_at: now, updated_at: now, deleted_at: null,
        ref_type: 'project', ref_id: 8, ref_snapshot: { client: null, status: 'active' }, origin: 'user',
      }] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  } as unknown as PoolClient
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  const runtime = createPostgresMindRefNodeCreateRuntime(pool, async () => {})

  const result = await runtime.transaction('owner-a', (tx) => tx.create('owner-a', 'project', 8))

  assert.equal(result.created, true)
  assert.equal(result.node.id, 42)
  assert.equal(typeof result.node.id, 'number')
  assert.deepEqual(calls.find((call) => call.sql.includes('FROM projects'))?.values, [8, 'owner-a'])
})
