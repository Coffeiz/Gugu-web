import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindCanvasMutations,
  MindCanvasMutationError,
  type MindCanvasMutationRuntime,
  type MindCanvasRecord,
} from '../../src/domains/mind/application/mind-canvas-mutations.js'

const ownerId = 'synthetic-owner'
const metadata = { undoContextId: 'undo-context', clientId: 'mind-client' }
const timestamp = new Date('2026-11-14T01:02:03.000Z')

function canvas(overrides: Partial<MindCanvasRecord> = {}): MindCanvasRecord {
  return {
    id: 7,
    title: '画布',
    project_id: 3,
    data_json: '{"zoom":1}',
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  }
}

test('canvas creation keeps Python defaults, owner-scoped project validation, atomic undo, then publishes', async () => {
  const order: string[] = []
  let recordedOwner = ''
  let undoRecord: unknown
  const runtime: MindCanvasMutationRuntime = {
    async transaction(requestOwnerId, work) {
      recordedOwner = requestOwnerId
      return work({
        async projectExistsForOwner(owner, projectId) { order.push(`project:${owner}:${projectId}`); return owner === ownerId },
        async insert(owner, title, projectId) {
          order.push(`insert:${owner}:${title}:${projectId}`)
          return canvas({ title, project_id: projectId, data_json: '{}' })
        },
        async getOwned() { return null },
        async update() { return null },
        async recordUndo(record) { undoRecord = record; order.push('undo') },
      })
    },
    async publishChanged(event) { order.push(`publish:${event.origin}:${event.entityId}`) },
  }
  const mutations = createMindCanvasMutations(runtime)

  const result = await mutations.create(ownerId, { project_id: '3', title: '  ' }, metadata)

  assert.equal(recordedOwner, ownerId)
  assert.equal(result.title, '未命名画布')
  assert.equal(result.projectId, 3)
  assert.deepEqual(order, [`project:${ownerId}:3`, `insert:${ownerId}:未命名画布:3`, 'undo', 'publish:mind-client:7'])
  assert.deepEqual(undoRecord, {
    userId: ownerId,
    contextId: 'undo-context',
    resource: 'mind',
    action: 'create',
    targetRefs: [{ kind: 'canvas', id: 7 }],
    beforeState: { items: {} },
    afterState: { items: { 'canvas:7': { id: 7, title: '未命名画布', project_id: 3, data_json: '{}', deleted_at: null } } },
    baseVersions: { 'canvas:7': {} },
  })
})

test('canvas creation rejects a project owned by somebody else before inserting', async () => {
  let inserted = false
  const mutations = createMindCanvasMutations({
    async transaction(_ownerId, work) {
      return work({
        async projectExistsForOwner() { return false },
        async insert() { inserted = true; return canvas() },
        async getOwned() { return null },
        async update() { return null },
        async recordUndo() {},
      })
    },
    async publishChanged() {},
  })

  await assert.rejects(mutations.create(ownerId, { projectId: 9 }, metadata), (error: unknown) =>
    error instanceof MindCanvasMutationError && error.statusCode === 404,
  )
  assert.equal(inserted, false)
})

test('canvas update keeps omitted fields, stores explicit null data, records before and after, then publishes', async () => {
  const order: string[] = []
  let updateFields: { title?: string; dataJson?: string } | undefined
  let undoRecord: { action: string; beforeState: unknown; afterState: unknown } | undefined
  const mutations = createMindCanvasMutations({
    async transaction(_ownerId, work) {
      return work({
        async projectExistsForOwner() { return true },
        async insert() { return canvas() },
        async getOwned(owner, id) { order.push(`lock:${owner}:${id}`); return canvas() },
        async update(owner, id, fields) {
          order.push(`update:${owner}:${id}`)
          updateFields = fields
          return canvas({ data_json: fields.dataJson ?? '{"zoom":1}', updated_at: new Date('2026-11-14T02:00:00.000Z') })
        },
        async recordUndo(record) { undoRecord = record; order.push('undo') },
      })
    },
    async publishChanged() { order.push('publish') },
  })

  const result = await mutations.update(ownerId, 7, { data: null }, metadata)

  assert.deepEqual(updateFields, { dataJson: 'null' })
  assert.deepEqual(result.data, {})
  assert.equal(undoRecord?.action, 'update')
  assert.deepEqual(undoRecord?.beforeState, { items: { 'canvas:7': { id: 7, title: '画布', project_id: 3, data_json: '{"zoom":1}', deleted_at: null } } })
  assert.deepEqual(undoRecord?.afterState, { items: { 'canvas:7': { id: 7, title: '画布', project_id: 3, data_json: 'null', deleted_at: null } } })
  assert.deepEqual(order, [`lock:${ownerId}:7`, `update:${ownerId}:7`, 'undo', 'publish'])
})

test('canvas update hides another owner and rejects non-object view data', async () => {
  let updated = false
  const mutations = createMindCanvasMutations({
    async transaction(_ownerId, work) {
      return work({
        async projectExistsForOwner() { return true },
        async insert() { return canvas() },
        async getOwned() { return null },
        async update() { updated = true; return canvas() },
        async recordUndo() {},
      })
    },
    async publishChanged() {},
  })

  await assert.rejects(mutations.update(ownerId, 7, { title: '新标题' }, metadata), (error: unknown) =>
    error instanceof MindCanvasMutationError && error.statusCode === 404,
  )
  await assert.rejects(mutations.update(ownerId, 7, { data: [] }, metadata), MindCanvasMutationError)
  assert.equal(updated, false)
})
