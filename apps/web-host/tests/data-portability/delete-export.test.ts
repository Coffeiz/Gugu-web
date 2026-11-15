import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {createDataExportDeleter} from '@gugu/core/data-portability/delete-export'
import { registerDataExportDeleteRoute } from '../../src/modules/data-portability/delete-export.js'

test('导出删除认证后按 owner 删除，活动任务拒绝，归档失败保留任务', async () => {
  const app = Fastify()
  const ownerA='00000000-0000-4000-8000-000000000011',ownerB='00000000-0000-4000-8000-000000000012'
  const calls: string[] = [], jobs = new Map([
    ['00000000-0000-4000-8000-000000000001', { owner: ownerA, status: 'ready', artifactKey: 'private-1' }],
    ['00000000-0000-4000-8000-000000000002', { owner: ownerA, status: 'running', artifactKey: null }],
    ['00000000-0000-4000-8000-000000000003', { owner: ownerA, status: 'failed', artifactKey: 'private-3' }],
    ['00000000-0000-4000-8000-000000000004', { owner: ownerB, status: 'ready', artifactKey: 'private-4' }],
  ])
  const remove = createDataExportDeleter({
    transaction: work => work({
      async findOwnedForUpdate(owner, job) {
        const row = jobs.get(job)
        return row?.owner === owner ? { status: row.status, artifactKey: row.artifactKey } : null
      },
      async deleteOwned(_owner, job) { jobs.delete(job) },
    }),
  }, async (owner, job, key) => {
    calls.push(`artifact:${owner}:${job}:${key}`)
    if (job.endsWith('000000000003')) throw new Error('disk unavailable')
  })
  registerDataExportDeleteRoute(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'Bearer valid') return reply.code(401).send()
    },
    ownerIdFromRequest: () => ownerA,
    remove,
  })
  try {
    const headers = { authorization: 'Bearer valid' }
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/00000000-0000-4000-8000-000000000001' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/not-a-uuid', headers })).statusCode, 422)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/00000000-0000-4000-8000-000000000001', headers })).statusCode, 204)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/00000000-0000-4000-8000-000000000002', headers })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/00000000-0000-4000-8000-000000000003', headers })).statusCode, 503)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/exports/00000000-0000-4000-8000-000000000004', headers })).statusCode, 404)
    assert.deepEqual(calls, [
      `artifact:${ownerA}:00000000-0000-4000-8000-000000000001:private-1`,
      `artifact:${ownerA}:00000000-0000-4000-8000-000000000003:private-3`,
    ])
    assert.equal(jobs.has('00000000-0000-4000-8000-000000000001'), false)
    assert.equal(jobs.has('00000000-0000-4000-8000-000000000003'), true)
    assert.equal(jobs.has('00000000-0000-4000-8000-000000000004'), true)
  } finally { await app.close() }
})
