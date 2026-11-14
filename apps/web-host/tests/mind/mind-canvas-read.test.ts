import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { Pool } from 'pg'
import {
  createPostgresMindCanvasReader,
  registerMindCanvasReadRoutes,
  type MindCanvasReadOperations,
} from '../../src/domains/mind/mind-canvas-read.js'

const ownerId = 'owner-mind-canvas'
const now = new Date('2026-11-14T01:02:03.000Z')

test('canvas reads return active owner rows and hydrate event reference cards in one owner-scoped batch', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      if (sql.includes('FROM mind_maps') && sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] }
      if (sql.includes('FROM mind_canvas_items ci')) return { rows: [{
        id: '10', canvas_id: '7', node_id: '8', x: 12, y: 24, w: null, h: 160, z: 3,
        collapsed: false, item_data_json: '{"color":"blue"}', item_created_at: now, item_updated_at: now,
        kind: 'ref', node_title: '会议', content_md: '', color: null, captured_at: now,
        version: 1, node_created_at: now, node_updated_at: now, node_deleted_at: null,
        ref_type: 'event', ref_id: '9', ref_snapshot: null,
      }] }
      if (sql.includes('FROM calendar_events')) return { rows: [{
        id: '9', date: '2026-11-15', time: '09:00', end_time: '10:00', description: '评审',
      }] }
      throw new Error('unexpected query')
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindCanvasReader(pool)

  const rows = await reader.listItems(ownerId, 7)

  assert.equal(rows?.length, 1)
  assert.deepEqual(rows?.[0], {
    id: 10, canvasId: 7, nodeId: 8, x: 12, y: 24, w: null, h: 160, z: 3, collapsed: false,
    data: { color: 'blue' },
    refData: { date: '2026-11-15', time: '09:00', endTime: '10:00', description: '评审' },
    node: {
      id: 8, kind: 'ref', title: '会议', contentMd: '', color: null,
      capturedAt: '2026-11-14T01:02:03.000+00:00', version: 1,
      createdAt: '2026-11-14T01:02:03.000+00:00', updatedAt: '2026-11-14T01:02:03.000+00:00',
      deletedAt: null, refType: 'event', refId: 9, refSnapshot: null,
    },
    createdAt: '2026-11-14T01:02:03.000+00:00', updatedAt: '2026-11-14T01:02:03.000+00:00',
  })
  assert.deepEqual(calls.map((call) => call.values), [[7, ownerId], [7, ownerId], [ownerId, [9]]])
  assert.match(calls[1]?.sql ?? '', /n\.user_id=\$2 AND n\.deleted_at IS NULL/)
  assert.match(calls[2]?.sql ?? '', /user_id=\$1 AND deleted_at IS NULL AND id=ANY\(\$2::bigint\[\]\)/)
})

test('canvas reads hide another owner, deleted canvases, deleted items, and detached relations', async () => {
  let call = 0
  const pool = {
    async query() {
      call += 1
      if (call === 1) return { rows: [] }
      if (call === 2) return { rows: [{ data_json: '{"detachedRelationIds":[12]}' }] }
      return { rows: [
        { id: '11', canvas_id: '7', src_node_id: '1', dst_node_id: '2', rel_type: 'related', origin: 'user', status: 'confirmed', created_at: now, updated_at: now },
        { id: '12', canvas_id: '7', src_node_id: '2', dst_node_id: '3', rel_type: 'related', origin: 'gugu', status: 'suggested', created_at: now, updated_at: now },
      ] }
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindCanvasReader(pool)

  assert.equal(await reader.listItems(ownerId, 77), null)
  const relations = await reader.listRelations(ownerId, 7)

  assert.deepEqual(relations?.map((row) => row.id), [11])
})

test('canvas list defaults to all owned active canvases and preserves the optional project filter', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values })
      return { rows: [{ id: '5', title: '项目画布', project_id: '2', data_json: '{"x":4}', created_at: now, updated_at: now }] }
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindCanvasReader(pool)

  assert.equal((await reader.listCanvases(ownerId, null))[0]?.data.x, 4)
  assert.equal((await reader.listCanvases(ownerId, 2))[0]?.projectId, 2)
  assert.deepEqual(calls.map((call) => call.values), [[ownerId], [ownerId, 2]])
  assert.match(calls[0]?.sql ?? '', /user_id=\$1 AND deleted_at IS NULL/)
  assert.match(calls[1]?.sql ?? '', /project_id=\$2/)
})

test('canvas-note location is owner-scoped and excludes deleted notes, items, and canvases', async () => {
  let values: unknown[] | undefined
  const pool = {
    async query(_sql: string, queryValues?: unknown[]) {
      values = queryValues
      return { rows: [{ canvas_id: '7' }] }
    },
  } as unknown as Pick<Pool, 'query'>
  const reader = createPostgresMindCanvasReader(pool)

  assert.equal(await reader.canvasLocation(ownerId, 8), 7)
  assert.deepEqual(values, [8, ownerId])
})

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
