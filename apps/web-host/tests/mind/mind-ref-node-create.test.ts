import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindRefNodeCreator,
  MindRefNodeCreateError,
  type MindReferenceNodeSnapshot,
  type MindRefNodeCreateRuntime,
} from '../../src/domains/mind/application/mind-ref-node-create.js'

const timestamp = new Date('2026-11-14T01:02:03.000Z')
const referenceNode: MindReferenceNodeSnapshot = {
  id: 31, kind: 'ref', title: '星尘计划', content_md: '', content_plain: '',
  color: 'linear-gradient(135deg, #7b7fb2, #c4afc8)', captured_at: timestamp, version: 1,
  created_at: timestamp, updated_at: timestamp, deleted_at: null,
  ref_type: 'project', ref_id: 8,
  ref_snapshot: { client: '小北', status: 'active', startDate: '2026-11-01', deadline: '2026-12-01', doneAt: null },
  origin: 'user',
}
const metadata = { undoContextId: 'mind-tab', clientId: 'mind-client', mutationId: 'mutation-31' }

test('reference node creation snapshots the owned target, records Python-compatible Undo and publishes after commit', async () => {
  const order: string[] = []
  let undo: unknown
  let event: unknown
  const runtime: MindRefNodeCreateRuntime = {
    async transaction(ownerId, work) {
      const result = await work({
        async create(requestOwner, refType, refId) {
          order.push(`target:${requestOwner}:${refType}:${refId}`)
          return { node: referenceNode, created: true }
        },
        async recordUndo(record) { undo = record; order.push('undo') },
      })
      order.push('commit')
      return result
    },
    async publishChanged(value) { event = value; order.push('publish') },
  }

  const result = await createMindRefNodeCreator(runtime).create('owner-a', { refType: 'project', refId: '8' }, metadata)

  assert.deepEqual(order, ['target:owner-a:project:8', 'undo', 'commit', 'publish'])
  assert.deepEqual({ id: result.id, kind: result.kind, title: result.title, refType: result.refType, refId: result.refId, refSnapshot: result.refSnapshot }, {
    id: 31, kind: 'ref', title: '星尘计划', refType: 'project', refId: 8,
    refSnapshot: referenceNode.ref_snapshot,
  })
  assert.deepEqual(undo, {
    userId: 'owner-a', contextId: 'mind-tab', resource: 'mind', action: 'create',
    targetRefs: [{ kind: 'ref_node', id: 31 }], beforeState: { items: {} },
    afterState: { items: { 'ref_node:31': {
      id: 31, kind: 'ref', title: '星尘计划', content_md: '', content_plain: '',
      color: referenceNode.color, captured_at: '2026-11-14T01:02:03.000+00:00', version: 1,
      ref_type: 'project', ref_id: 8, ref_snapshot: referenceNode.ref_snapshot,
      origin: 'user', deleted_at: null,
    } } },
    baseVersions: { 'ref_node:31': { version: 0 } },
  })
  assert.deepEqual(event, {
    ownerId: 'owner-a', entityId: 31, origin: 'mind-client', mutationId: 'mutation-31', entity: result,
  })
})

test('idempotent reference creation reuses node without another Undo or change event', async () => {
  let undoCount = 0
  let eventCount = 0
  const runtime: MindRefNodeCreateRuntime = {
    async transaction(_ownerId, work) {
      return work({
        async create() { return { node: referenceNode, created: false } },
        async recordUndo() { undoCount += 1 },
      })
    },
    async publishChanged() { eventCount += 1 },
  }

  const first = await createMindRefNodeCreator(runtime).create('owner-a', { ref_type: 'project', ref_id: 8 }, metadata)
  assert.equal(first.id, referenceNode.id)
  assert.equal(undoCount, 0)
  assert.equal(eventCount, 0)
})

test('reference type, id and missing owner-scoped target fail with Python-compatible statuses', async () => {
  let transactions = 0
  const runtime: MindRefNodeCreateRuntime = {
    async transaction(_ownerId, work) {
      transactions += 1
      return work({
        async create() { throw new MindRefNodeCreateError(404, '引用对象不存在') },
        async recordUndo() {},
      })
    },
    async publishChanged() {},
  }
  const creator = createMindRefNodeCreator(runtime)
  const create = creator.create

  await assert.rejects(create('owner-a', { refType: 'client', refId: 2 }, metadata),
    (error: unknown) => error instanceof MindRefNodeCreateError && error.statusCode === 422)
  await assert.rejects(create('owner-a', { refType: 'event', refId: 'bad' }, metadata),
    (error: unknown) => error instanceof MindRefNodeCreateError && error.statusCode === 422)
  await assert.rejects(create('owner-a', { refType: 'event', refId: 2 }, metadata),
    (error: unknown) => error instanceof MindRefNodeCreateError && error.statusCode === 404)
  assert.equal(transactions, 1)
})
