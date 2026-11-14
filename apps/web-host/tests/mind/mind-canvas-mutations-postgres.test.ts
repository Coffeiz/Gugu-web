import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createMindCanvasMutations } from '../../src/domains/mind/application/mind-canvas-mutations.js'
import { createPostgresMindCanvasMutationRuntime } from '../../src/domains/mind/persistence/mind-canvas-mutations-postgres.js'

const ownerId = 'synthetic-canvas-owner'
const now = new Date('2026-11-14T01:02:03.000Z')

test('PostgreSQL canvas creation binds project and canvas to the authenticated owner and publishes after commit', async () => {
  const order: string[] = []
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql === 'BEGIN') { order.push('begin'); return { rows: [] } }
      if (sql === 'COMMIT') { order.push('commit'); return { rows: [] } }
      if (sql === 'ROLLBACK') { order.push('rollback'); return { rows: [] } }
      if (sql.includes('FROM projects')) return { rows: [{ '?column?': 1 }] }
      if (sql.includes('INSERT INTO mind_maps')) return { rows: [{
        id: '42', title: '画布', project_id: '5', data_json: '{}', created_at: now, updated_at: now,
      }] }
      if (sql.includes('UPDATE undo_operations') || sql.includes('INSERT INTO undo_operations')) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() { order.push('release') },
  } as unknown as PoolClient
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  const runtime = createPostgresMindCanvasMutationRuntime(pool, async (event) => {
    order.push(`publish:${event.ownerId}:${event.entityId}`)
  })
  const mutations = createMindCanvasMutations(runtime)

  const result = await mutations.create(ownerId, { title: '画布', projectId: 5 }, {
    undoContextId: 'undo-canvas', clientId: 'client-canvas',
  })

  assert.equal(result.id, 42)
  assert.deepEqual(calls.find((call) => call.sql.includes('FROM projects'))?.values, [5, ownerId])
  assert.deepEqual(calls.find((call) => call.sql.includes('INSERT INTO mind_maps'))?.values, [ownerId, '画布', 5])
  assert.deepEqual(order, ['begin', 'commit', 'release', `publish:${ownerId}:42`])
  const undoInsert = calls.find((call) => call.sql.includes('INSERT INTO undo_operations'))
  assert.equal(undoInsert?.values?.[1], ownerId)
})
