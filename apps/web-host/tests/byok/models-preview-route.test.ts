import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { registerCredentialModelsPreviewRoute } from '../../src/modules/byok/routes.js'

const ownerId = '00000000-0000-4000-8000-000000000161'
const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('models-preview matches Pydantic integer DTOs without treating an empty ID as zero', async () => {
  const app = Fastify()
  apps.push(app)
  const seen: Array<number | null | undefined> = []
  registerCredentialModelsPreviewRoute(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    preview: async (_owner, input) => {
      seen.push(input.credential_id)
      return { models: ['synthetic-model'] }
    },
  })

  const empty = await app.inject({ method: 'POST', url: '/api/v1/byok/models-preview',
    payload: { provider: 'deepseek', credential_id: '' } })
  const numericString = await app.inject({ method: 'POST', url: '/api/v1/byok/models-preview',
    payload: { provider: 'deepseek', credential_id: '7' } })

  assert.equal(empty.statusCode, 422)
  assert.equal(numericString.statusCode, 200)
  assert.deepEqual(seen, [7])
})
