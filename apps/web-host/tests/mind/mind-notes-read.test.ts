import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {
  registerMindNoteReadRoutes,
  type MindNoteReadResponse,
} from '../../src/domains/mind/mind-notes-read.js'

const ownerId = 'owner-mind-read'

function note(overrides: Partial<MindNoteReadResponse> = {}): MindNoteReadResponse {
  return {
    id: 8,
    kind: 'note',
    title: '记录',
    contentMd: '正文',
    color: null,
    capturedAt: '2026-11-13T10:00:00.000+00:00',
    version: 2,
    createdAt: '2026-11-13T10:00:00.000+00:00',
    updatedAt: '2026-11-13T10:00:00.000+00:00',
    deletedAt: null,
    refType: null,
    refId: null,
    refSnapshot: null,
    ...overrides,
  }
}

test('Mind note routes preserve pagination defaults and reject values outside Python bounds', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  const operations = {
    async list(...args: [string, number, number]) { calls.push(args); return [note()] },
    async get() { return null },
  }
  registerMindNoteReadRoutes(app, () => ownerId, operations)
  try {
    const defaultPage = await app.inject({ method: 'GET', url: '/api/v1/mind/notes' })
    const page = await app.inject({ method: 'GET', url: '/api/v1/mind/notes?limit=10&offset=20' })
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/mind/notes?limit=201' })

    assert.equal(defaultPage.statusCode, 200)
    assert.equal(page.statusCode, 200)
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(calls, [[ownerId, 50, 0], [ownerId, 10, 20]])
  } finally {
    await app.close()
  }
})

test('Mind note detail binds the owner and maps hidden notes and malformed ids', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  const operations = {
    async list() { return [] },
    async get(...args: [string, number]) { calls.push(args); return args[1] === 8 ? note() : null },
  }
  registerMindNoteReadRoutes(app, () => ownerId, operations)
  try {
    const visible = await app.inject({ method: 'GET', url: '/api/v1/mind/notes/8' })
    const hidden = await app.inject({ method: 'GET', url: '/api/v1/mind/notes/9' })
    const malformed = await app.inject({ method: 'GET', url: '/api/v1/mind/notes/nope' })

    assert.equal(visible.statusCode, 200)
    assert.equal(hidden.statusCode, 404)
    assert.equal(malformed.statusCode, 422)
    assert.deepEqual(calls, [[ownerId, 8], [ownerId, 9]])
  } finally {
    await app.close()
  }
})
