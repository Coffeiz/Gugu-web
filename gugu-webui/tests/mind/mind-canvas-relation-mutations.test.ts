import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindCanvasRelationMutations,
  MindCanvasRelationMutationError,
  type MindCanvasRelationMutationRuntime,
  type MindCanvasRelationRecord,
} from '../../src/domains/mind/application/mind-canvas-relation-mutations.js'

const timestamp = new Date('2026-11-14T01:02:03.000Z')
const relation: MindCanvasRelationRecord = {
  id: 18, canvas_id: 4, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
  origin: 'user', status: 'confirmed', note: null,
  created_at: timestamp, updated_at: timestamp, deleted_at: null,
}
const metadata = { undoContextId: 'undo-context', clientId: 'mind-client', mutationId: 'mutation-1' }

test('canvas relation create keeps owner, Undo, metadata and post-transaction notification boundaries', async () => {
  const order: string[] = []
  let undo: unknown
  let event: unknown
  const runtime: MindCanvasRelationMutationRuntime = {
    async transaction(ownerId, work) {
      order.push(`begin:${ownerId}`)
      const result = await work({
        async create(requestOwner, canvasId, sourceId, targetId, allowParallel) {
          order.push(`create:${requestOwner}:${canvasId}:${sourceId}:${targetId}:${allowParallel}`)
          return { relation, before: null, created: true }
        },
        async delete() { return null },
        async deleteGlobal() { return null },
        async recordUndo(record) { undo = record; order.push('undo') },
      })
      order.push('commit')
      return result
    },
    async publishChanged(value) { event = value; order.push('publish') },
  }

  const result = await createMindCanvasRelationMutations(runtime).create('owner-a', {
    canvas_id: '4', src_node_id: '12', dst_node_id: 9, allow_parallel: false,
  }, metadata)

  assert.deepEqual(order, ['begin:owner-a', 'create:owner-a:4:12:9:false', 'undo', 'commit', 'publish'])
  assert.equal(result.id, relation.id)
  assert.equal(result.srcNodeId, relation.src_node_id)
  assert.equal(result.dstNodeId, relation.dst_node_id)
  assert.deepEqual(undo, {
    userId: 'owner-a', contextId: 'undo-context', resource: 'mind', action: 'create',
    targetRefs: [{ kind: 'relation', id: relation.id }],
    beforeState: { items: {} },
    afterState: { items: { 'relation:18': {
      id: 18, canvas_id: 4, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
      origin: 'user', status: 'confirmed', note: null, deleted_at: null,
    } } },
    baseVersions: { 'relation:18': {} },
  })
  assert.deepEqual(event, {
    ownerId: 'owner-a', operation: 'create', entityId: 18,
    origin: 'mind-client', mutationId: 'mutation-1', entity: result,
  })
})

test('idempotent relation creation returns existing edge and preserves Python create notification behavior', async () => {
  let publishes = 0
  const runtime: MindCanvasRelationMutationRuntime = {
    async transaction(_ownerId, work) {
      return work({
        async create() { return { relation, before: relation, created: false } },
        async delete() { return null },
        async deleteGlobal() { return null },
        async recordUndo() {},
      })
    },
    async publishChanged() { publishes += 1 },
  }

  const result = await createMindCanvasRelationMutations(runtime).create('owner-a', {
    canvasId: 4, srcNodeId: 9, dstNodeId: 12,
  }, metadata)

  assert.equal(result.id, relation.id)
  assert.equal(publishes, 1)
})

test('self relation and malformed parallel-edge flag fail before persistence', async () => {
  let transactions = 0
  const runtime: MindCanvasRelationMutationRuntime = {
    async transaction(_ownerId, work) {
      transactions += 1
      return work({
        async create() { return { relation, before: null, created: true } },
        async delete() { return null },
        async deleteGlobal() { return null },
        async recordUndo() {},
      })
    },
    async publishChanged() {},
  }
  const mutations = createMindCanvasRelationMutations(runtime)

  await assert.rejects(mutations.create('owner-a', { canvasId: 4, srcNodeId: 9, dstNodeId: 9 }, metadata),
    (error: unknown) => error instanceof MindCanvasRelationMutationError && error.statusCode === 422)
  await assert.rejects(mutations.create('owner-a', {
    canvasId: 4, srcNodeId: 9, dstNodeId: 12, allowParallel: 'yes',
  }, metadata),
  (error: unknown) => error instanceof MindCanvasRelationMutationError && error.statusCode === 422)
  assert.equal(transactions, 0)
})

test('relation delete records reversible state and publishes only after transaction completion', async () => {
  const deleted = { ...relation, deleted_at: timestamp }
  const order: string[] = []
  let undo: unknown
  const runtime: MindCanvasRelationMutationRuntime = {
    async transaction(_ownerId, work) {
      const result = await work({
        async create() { return { relation, before: null, created: true } },
        async delete(ownerId, canvasId, id) {
          order.push(`delete:${ownerId}:${canvasId}:${id}`)
          return { before: relation, after: deleted }
        },
        async deleteGlobal() { return null },
        async recordUndo(record) { undo = record; order.push('undo') },
      })
      order.push('commit')
      return result
    },
    async publishChanged(event) { order.push(`publish:${event.operation}`) },
  }

  await createMindCanvasRelationMutations(runtime).delete('owner-a', 4, 18, metadata)

  assert.deepEqual(order, ['delete:owner-a:4:18', 'undo', 'commit', 'publish:delete'])
  assert.deepEqual(undo, {
    userId: 'owner-a', contextId: 'undo-context', resource: 'mind', action: 'delete',
    targetRefs: [{ kind: 'relation', id: 18 }],
    beforeState: { items: { 'relation:18': {
      id: 18, canvas_id: 4, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
      origin: 'user', status: 'confirmed', note: null, deleted_at: null,
    } } },
    afterState: { items: { 'relation:18': {
      id: 18, canvas_id: 4, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
      origin: 'user', status: 'confirmed', note: null, deleted_at: '2026-11-14T01:02:03.000+00:00',
    } } },
    baseVersions: { 'relation:18': {} },
  })
})

test('global relation delete hides canvas relations, records null-canvas Undo and publishes after commit', async () => {
  const globalRelation = { ...relation, canvas_id: null }
  const deleted = { ...globalRelation, deleted_at: timestamp }
  const order: string[] = []
  let undo: unknown
  let event: unknown
  const runtime: MindCanvasRelationMutationRuntime = {
    async transaction(ownerId, work) {
      const result = await work({
        async create() { return { relation: globalRelation, before: null, created: true } },
        async delete() { return null },
        async deleteGlobal(requestOwner, id) {
          order.push(`delete:${requestOwner}:${id}`)
          return requestOwner === 'owner-a' && id === 18 ? { before: globalRelation, after: deleted } : null
        },
        async recordUndo(record) { undo = record; order.push('undo') },
      })
      order.push('commit')
      return result
    },
    async publishChanged(value) { event = value; order.push('publish') },
  }

  await createMindCanvasRelationMutations(runtime).deleteGlobal('owner-a', 18, metadata)

  assert.deepEqual(order, ['delete:owner-a:18', 'undo', 'commit', 'publish'])
  assert.deepEqual(undo, {
    userId: 'owner-a', contextId: 'undo-context', resource: 'mind', action: 'delete',
    targetRefs: [{ kind: 'relation', id: 18 }],
    beforeState: { items: { 'relation:18': {
      id: 18, canvas_id: null, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
      origin: 'user', status: 'confirmed', note: null, deleted_at: null,
    } } },
    afterState: { items: { 'relation:18': {
      id: 18, canvas_id: null, src_node_id: 9, dst_node_id: 12, rel_type: 'related', edge_key: '',
      origin: 'user', status: 'confirmed', note: null, deleted_at: '2026-11-14T01:02:03.000+00:00',
    } } },
    baseVersions: { 'relation:18': {} },
  })
  assert.deepEqual(event, {
    ownerId: 'owner-a', operation: 'delete', entityId: 18, origin: 'mind-client',
    mutationId: 'mutation-1', entity: { id: 18, canvas_id: null },
  })
})
