import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { registerFileBrowserRoutes } from '../../src/domains/files/browser.js'

test('Python file and folder page aliases return the same owner-scoped page shape', async () => {
  const app = Fastify({ routerOptions: { ignoreTrailingSlash: true } })
  const calls: string[] = []
  registerFileBrowserRoutes(app, {
    requireUser(_request, _reply, done) { done() },
    ownerIdFromRequest() { return '00000000-0000-4000-8000-000000000001' },
    operations: {
      async listFiles() { calls.push('files'); return { items: [] } },
      async listFolders() { calls.push('folders'); return { items: [] } },
    },
  })

  try {
    for (const path of ['/api/v1/files', '/api/v1/files/', '/api/v1/files/page']) {
      const response = await app.inject({ url: `${path}?space=personal` })
      assert.equal(response.statusCode, 200, path)
      assert.deepEqual(response.json(), { items: [] })
    }
    for (const path of ['/api/v1/folders', '/api/v1/folders/', '/api/v1/folders/page']) {
      const response = await app.inject({ url: path })
      assert.equal(response.statusCode, 200, path)
      assert.deepEqual(response.json(), { items: [] })
    }
    assert.deepEqual(calls, ['files', 'files', 'files', 'folders', 'folders', 'folders'])
  } finally {
    await app.close()
  }
})
