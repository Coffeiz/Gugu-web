import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { Pool } from 'pg'
import {
  createPostgresMindNoteReader,
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

function date(value: string): Date {
  return new Date(value)
}

test('Mind note reader scopes the timeline to active notes owned by the authenticated user', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      return { rows: [{
        id: '8', kind: 'note', title: '记录', content_md: '正文', color: null,
        captured_at: date('2026-11-13T10:00:00Z'), version: '2',
        created_at: date('2026-11-13T10:00:00Z'), updated_at: date('2026-11-13T10:00:00Z'),
        deleted_at: null, ref_type: null, ref_id: null, ref_snapshot: null,
      }] }
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindNoteReader(pool)

  const rows = await reader.list(ownerId, 25, 50)

  assert.deepEqual(calls[0]?.values, [ownerId, 25, 50])
  assert.match(calls[0]?.sql ?? '', /user_id = \$1 AND kind = 'note' AND deleted_at IS NULL/)
  assert.match(calls[0]?.sql ?? '', /ORDER BY date\(captured_at\) DESC, created_at DESC, id DESC/)
  assert.deepEqual(rows, [note()])
})

test('Mind note reader hides missing, deleted, non-note, and other-owner rows as not found', async () => {
  let calledWith: unknown[] | undefined
  const pool = {
    async query(_sql: string, values?: unknown[]) {
      calledWith = values
      return { rows: [] }
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindNoteReader(pool)

  assert.equal(await reader.get(ownerId, 999), null)
  assert.deepEqual(calledWith, [999, ownerId])
})

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
