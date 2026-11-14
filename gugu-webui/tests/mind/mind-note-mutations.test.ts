import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindNoteMutations,
  MindNoteMutationError,
  prepareMindNoteUpdate,
} from '../../src/domains/mind/application/mind-note-mutations.js'

const now = new Date('2026-11-14T10:00:00.000Z')

test('note update validates Python fields, derives index values, and accepts only past capture times', () => {
  const input = prepareMindNoteUpdate({
    version: '3',
    content_md: '# Updated\n\n- Read [[project:7|Moon plan]]',
    title: '🪿'.repeat(300),
    color: null,
    capturedAt: '2026-11-13T10:00:00+00:00',
  }, now)
  assert.equal(input.version, 3)
  assert.equal(input.contentPlain, 'Updated\nRead Moon plan')
  assert.equal(input.indexedHash, '3d7fd6f95f985b75dfa55389e5345ba7b222d65458f8c046905526a5c783d538')
  assert.equal(input.capturedAt?.toISOString(), '2026-11-13T10:00:00.000Z')
  assert.equal([...(input.title ?? '')].length, 300)
  assert.equal(input.color, null)
})

test('note update rejects missing version, invalid title/color/content, and future capture times', () => {
  for (const body of [
    { title: 'missing version' },
    { version: 1, title: 'x'.repeat(301) },
    { version: 1, color: 'url(javascript:alert(1))' },
    { version: 1, contentMd: 4 },
    { version: 1, capturedAt: '2026-11-14T10:00:00.001Z' },
  ]) assert.throws(() => prepareMindNoteUpdate(body, now), MindNoteMutationError)
})

test('no-op update returns the current note without publication; real updates publish after persistence', async () => {
  const order: string[] = []
  const mutationIds: Array<string | null> = []
  const note = {
    id: 7, kind: 'note', title: null, contentMd: 'saved', color: null,
    capturedAt: now.toISOString(), version: 2, createdAt: now.toISOString(),
    updatedAt: now.toISOString(), deletedAt: null, refType: null, refId: null, refSnapshot: null,
  }
  const mutations = createMindNoteMutations({
    async update(_ownerId, _noteId, input) {
      order.push(`persist:${input.version}`)
      return { note, changed: Object.keys(input).length > 1 }
    },
    async delete() { order.push('delete') },
    async publishUpdated(event) {
      mutationIds.push(event.mutationId)
      order.push('publish')
      throw new Error('redis unavailable')
    },
    async publishDeleted() { order.push('publish-delete') },
    reportFailure(operation) { order.push(`reported:${operation}`) },
  })

  assert.equal(await mutations.update('owner-a', 7, { version: 2 }, { undoContextId: null, clientId: null }), note)
  await mutations.update('owner-a', 7, { version: 2, contentMd: 'new' }, {
    undoContextId: 'undo-a', clientId: 'tab-a', mutationId: 'mutation-a',
  })
  assert.deepEqual(order, [
    'persist:2', 'persist:2', 'publish', 'reported:Mind note update notification',
  ])
  assert.deepEqual(mutationIds, ['mutation-a'])
})

test('delete publishes only after persistence and isolates notification failure', async () => {
  const order: string[] = []
  const mutations = createMindNoteMutations({
    async update() { throw new Error('unused') },
    async delete(ownerId, noteId, undoContextId) { order.push(`persist:${ownerId}:${noteId}:${undoContextId}`) },
    async publishUpdated() {},
    async publishDeleted() { order.push('publish'); throw new Error('redis unavailable') },
    reportFailure(operation) { order.push(`reported:${operation}`) },
  })
  await mutations.delete('owner-a', 7, { undoContextId: 'undo-a', clientId: 'tab-a' })
  assert.deepEqual(order, [
    'persist:owner-a:7:undo-a', 'publish', 'reported:Mind note delete notification',
  ])
})
