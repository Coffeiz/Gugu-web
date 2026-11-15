import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {
  registerMindCanvasReadRoutes,
  type MindCanvasReadOperations,
} from '../../src/domains/mind/mind-canvas-read.js'

const ownerId = 'owner-mind-canvas'
test('canvas read routes require a valid id, hide other-owner canvases, and retain Python empty-list contracts', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  const operations: MindCanvasReadOperations = {
    async listCanvases(...args) { calls.push(args); return [] },
    async listItems(...args) { calls.push(args); return args[1] === 7 ? [] : null },
    async listRelations(...args) { calls.push(args); return args[1] === 7 ? [] : null },
    async canvasLocation(...args) { calls.push(args); return args[1] === 9 ? 7 : null },
  }
  registerMindCanvasReadRoutes(app, () => ownerId, operations)
  try {
    const canvases = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases?project_id=4' })
    const invalidProject = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases?project_id=bad' })
    const items = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases/7/items' })
    const hidden = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases/8/relations' })
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases/nope/items' })
    const location = await app.inject({ method: 'GET', url: '/api/v1/mind/nodes/9/canvas-location' })
    const missingLocation = await app.inject({ method: 'GET', url: '/api/v1/mind/nodes/10/canvas-location' })

    assert.equal(canvases.statusCode, 200)
    assert.deepEqual(canvases.json(), [])
    assert.equal(invalidProject.statusCode, 422)
    assert.equal(items.statusCode, 200)
    assert.deepEqual(items.json(), [])
    assert.equal(hidden.statusCode, 404)
    assert.equal(invalid.statusCode, 422)
    assert.equal(location.statusCode, 200)
    assert.deepEqual(location.json(), { canvasId: 7 })
    assert.equal(missingLocation.statusCode, 404)
    assert.deepEqual(calls, [[ownerId, 4], [ownerId, 7], [ownerId, 8], [ownerId, 9], [ownerId, 10]])
  } finally {
    await app.close()
  }
})
