import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMindNoteCreator,
  MindNoteCreateError,
  prepareMindNoteCreate,
} from '../../src/domains/mind/application/mind-note-create.js'

const now = new Date('2026-11-14T10:00:00.000Z')

test('note creation derives searchable plain text and hash from Markdown while accepting past capture time', () => {
  const input = prepareMindNoteCreate({
    contentMd: '# Follow up\n\n- [x] Read [the brief](https://example.test) for [[project:7|Moon plan]]',
    capturedAt: '2026-11-13T10:00:00+00:00',
    color: 'teal',
  }, now)

  assert.equal(input.contentPlain, 'Follow up\nRead the brief for Moon plan')
  assert.equal(input.indexedHash, 'b347250befee9ae8220c38e75589bb7c5d3db3292a80ce5a4c131afab855ce8d')
  assert.equal(input.title, null)
  assert.equal(input.capturedAt.toISOString(), '2026-11-13T10:00:00.000Z')
})

test('note creation applies Python-compatible defaults and rejects invalid fields or future capture time', () => {
  assert.deepEqual(prepareMindNoteCreate({}, now), {
    contentMd: '',
    contentPlain: '',
    indexedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    title: null,
    color: null,
    capturedAt: now,
  })
  assert.throws(() => prepareMindNoteCreate({ title: 'x'.repeat(301) }, now), MindNoteCreateError)
  assert.equal(prepareMindNoteCreate({ title: '🪿'.repeat(151) }, now).title, '🪿'.repeat(151))
  assert.throws(() => prepareMindNoteCreate({ color: 'url(javascript:alert(1))' }, now), MindNoteCreateError)
  assert.throws(() => prepareMindNoteCreate({ capturedAt: '2026-11-14T10:00:00.001Z' }, now), /不能创建未来日期/)
  assert.throws(() => prepareMindNoteCreate({ contentMd: 7 }, now), /正文必须是文本/)
})

test('note create publishes only after persistence and treats notification failure as best-effort', async () => {
  const order: string[] = []
  let mutationId: string | null = null
  const creator = createMindNoteCreator({
    async insert(ownerId, input, undoContextId) {
      order.push(`insert:${ownerId}:${input.contentMd}:${undoContextId}`)
      return {
        id: 12, kind: 'note', title: null, contentMd: input.contentMd, color: input.color,
        capturedAt: input.capturedAt.toISOString(), version: 1,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), deletedAt: null,
        refType: null, refId: null, refSnapshot: null,
      }
    },
    async publishCreated(publication) {
      mutationId = publication.mutationId
      order.push('publish')
      throw new Error('redis unavailable')
    },
    reportFailure(operation) { order.push(`reported:${operation}`) },
  })

  const result = await creator('owner-a', { contentMd: 'saved' }, {
    undoContextId: 'undo-a', clientId: 'client-a', mutationId: 'mutation-a',
  })

  assert.equal(result.id, 12)
  assert.deepEqual(order, [
    'insert:owner-a:saved:undo-a',
    'publish',
    'reported:Mind note resource notification',
  ])
  assert.equal(mutationId, 'mutation-a')
})
