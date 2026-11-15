import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { UserFromRequest } from '../../src/app.js'
import { registerScheduledTaskWrites } from '../../src/modules/scheduled-tasks/task-write-routes.js'
import type { createPostgresTaskWrites } from '../../src/modules/scheduled-tasks/persistence/task-writes-postgres.js'

test('任务路由转换 Python 接受的数字和布尔输入，并拒绝非法日期', async () => {
  const app = Fastify(), seen: unknown[] = []
  const writes = { async create(_owner: string, body: unknown) { seen.push(body); return { id: 1 } }, async update() { return {} } } as unknown as ReturnType<typeof createPostgresTaskWrites>
  registerScheduledTaskWrites(app, (() => ({ requestContext: { data: { ownerId: 'synthetic' } } })) as unknown as UserFromRequest, writes)
  try {
    const result = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', payload: { name: '任务', schedule_kind: 'once', start_at: 1893456000, event_id: '2', enabled: 'false' } })
    assert.equal(result.statusCode, 201)
    assert.deepEqual(seen, [{ name: '任务', schedule_kind: 'once', start_at: '2030-01-01T00:00:00.000000Z', event_id: 2, enabled: false }])
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', payload: { name: '任务', schedule_kind: 'once', start_at: '2026-02-30T08:00:00' } })
    assert.equal(invalid.statusCode, 422)
    assert.equal(seen.length, 1)
  } finally { await app.close() }
})
