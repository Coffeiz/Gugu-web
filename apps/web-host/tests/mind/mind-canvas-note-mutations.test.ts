import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindCanvasNoteMutations,
  MindCanvasNoteMutationError,
  type MindCanvasNoteMutationRuntime,
} from '../../src/domains/mind/application/mind-canvas-note-mutations.js'

const ownerId = 'synthetic-canvas-note-owner'
const metadata = { undoContextId: 'canvas-note-tab', clientId: 'canvas-note-client', mutationId: 'canvas-note-mutation' }
const note = {
  id: 8, kind: 'canvas_note', title: '新标题', contentMd: '正文', color: 'teal',
  capturedAt: '2026-11-14T01:00:00.000+00:00', version: 2,
  createdAt: '2026-11-14T01:00:00.000+00:00', updatedAt: '2026-11-14T02:00:00.000+00:00',
  deletedAt: null, refType: null, refId: null, refSnapshot: null,
}
const item = {
  id: 9, canvasId: 4, nodeId: 8, x: 12, y: 24, w: 180, h: 100, z: 0,
  collapsed: false, data: {}, refData: null, node: note,
  createdAt: note.createdAt, updatedAt: note.updatedAt,
}

test('canvas note creation applies Python defaults, color validation, Markdown indexing, and post-commit event metadata', async () => {
  let persistedInput: unknown
  let event: unknown
  const order: string[] = []
  const runtime: MindCanvasNoteMutationRuntime = {
    async create(owner, canvasId, input, undoContextId) {
      order.push(`create:${owner}:${canvasId}:${undoContextId}`)
      persistedInput = input
      return item
    },
    async update() { return { note, changed: false } },
    async publishChanged(value) { order.push('publish'); event = value },
  }
  const service = createMindCanvasNoteMutations(runtime)

  const result = await service.create(ownerId, 4, {
    title: '  想法  ', contentMd: '# 画布便签\n\n- 做事', color: 'blue', x: 16, y: -5, w: 100, h: 900,
  }, metadata)

  assert.equal(result.id, item.id)
  assert.deepEqual(persistedInput, {
    title: '想法', contentMd: '# 画布便签\n\n- 做事', color: 'blue', x: 16, y: -5, w: 180, h: 420, z: 0,
  })
  assert.deepEqual(order, [`create:${ownerId}:4:canvas-note-tab`, 'publish'])
  assert.deepEqual(event, {
    ownerId, operation: 'create', entityId: item.id, origin: metadata.clientId,
    mutationId: metadata.mutationId, entityKind: 'canvas_item', entity: item,
  })
})

test('canvas note creation rejects arbitrary colors and invalid coordinates before persistence', async () => {
  let creates = 0
  const runtime: MindCanvasNoteMutationRuntime = {
    async create() { creates += 1; return item },
    async update() { return { note, changed: false } },
    async publishChanged() {},
  }
  const service = createMindCanvasNoteMutations(runtime)

  await assert.rejects(service.create(ownerId, 4, { color: 'red' }, metadata), MindCanvasNoteMutationError)
  await assert.rejects(service.create(ownerId, 4, { x: Number.POSITIVE_INFINITY }, metadata), MindCanvasNoteMutationError)
  assert.equal(creates, 0)
})

test('canvas note update preserves empty titles, accepts only current palette values, and publishes only a committed change', async () => {
  let input: unknown
  let event: unknown
  let changed = true
  const service = createMindCanvasNoteMutations({
    async create() { return item },
    async update(owner, nodeId, value, undoContextId) {
      assert.equal(owner, ownerId)
      assert.equal(nodeId, note.id)
      assert.equal(undoContextId, metadata.undoContextId)
      input = value
      return { note, changed }
    },
    async publishChanged(value) { event = value },
  })

  const updated = await service.update(ownerId, note.id, {
    version: 1, title: '', content_md: '## 已完成', color: null,
  }, metadata)
  assert.equal(updated.version, 2)
  assert.deepEqual(input, { version: 1, title: '', contentMd: '## 已完成', color: null })
  assert.deepEqual(event, {
    ownerId, operation: 'update', entityId: note.id, origin: metadata.clientId,
    mutationId: metadata.mutationId, entityKind: 'canvas_note', entity: note,
  })

  changed = false
  event = undefined
  await service.update(ownerId, note.id, { version: 2 }, metadata)
  assert.equal(event, undefined)
  await assert.rejects(service.update(ownerId, note.id, { title: '改名' }, metadata), /version 必须是整数/)
  await assert.rejects(service.update(ownerId, note.id, { version: 2, color: 'red' }, metadata), MindCanvasNoteMutationError)
})
