import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { MindNoteMutationError } from '../../src/domains/mind/application/mind-note-mutations.js'
import { createPostgresMindNoteMutator } from '../../src/domains/mind/persistence/mind-note-mutations-postgres.js'

const now = new Date('2026-11-14T10:00:00.000Z')

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 41, kind: 'note', title: '旧标题', content_md: '旧正文', content_plain: '旧正文',
    color: 'amber', captured_at: now, version: 1, created_at: now, updated_at: now,
    deleted_at: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user',
    ...overrides,
  }
}

function setup(options: { before?: ReturnType<typeof row> | null; after?: ReturnType<typeof row>; failUndo?: boolean } = {}) {
  const statements: Array<{ sql: string; values?: unknown[] }> = []
  let released = 0
  const before = options.before === undefined ? row() : options.before
  const client = {
    async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
      statements.push({ sql, values })
      if (options.failUndo && sql.includes('INSERT INTO undo_operations')) throw new Error('synthetic undo failure')
      if (sql.includes('SELECT') && sql.includes('FROM mind_nodes'))
        return { rows: before ? [before as T] : [] }
      if (sql.includes('UPDATE mind_nodes')) return { rows: options.after ? [options.after as T] : [row({
        ...(sql.includes('deleted_at = CURRENT_TIMESTAMP') ? { deleted_at: now } : {}),
        version: 2, updated_at: now,
        ...(sql.includes('content_md =') ? { content_md: '新正文', content_plain: '新正文', indexed_hash: 'hash', indexed_at: null } : {}),
      }) as T] }
      return { rows: [] }
    },
    release() { released += 1 },
  }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  return { mutate: createPostgresMindNoteMutator(pool), statements, get released() { return released } }
}

test('note PATCH CAS-updates index fields and commits the compatible Undo snapshot atomically', async () => {
  const before = row()
  const after = row({ title: '新标题', content_md: '新正文', content_plain: '新正文', indexed_hash: 'hash',
    indexed_at: null, version: 2, updated_at: now })
  const state = setup({ before, after })
  const result = await state.mutate.update('owner-a', 41, {
    version: 1, title: '新标题', contentMd: '新正文', contentPlain: '新正文', indexedHash: 'hash',
  }, 'undo-a')

  assert.equal(result.changed, true)
  assert.equal(result.note.version, 2)
  assert.equal(state.statements[0]?.sql, 'BEGIN')
  assert.match(state.statements[1]?.sql ?? '', /FOR UPDATE/)
  const update = state.statements.find((entry) => entry.sql.includes('UPDATE mind_nodes'))
  assert.match(update?.sql ?? '', /user_id = \$2/)
  assert.match(update?.sql ?? '', /version = \$3/)
  assert.match(update?.sql ?? '', /indexed_at = NULL/)
  assert.deepEqual(update?.values?.slice(0, 3), [41, 'owner-a', 1])
  const undoInsert = state.statements.find((entry) => entry.sql.includes('INSERT INTO undo_operations'))
  assert.equal(undoInsert?.values?.[4], 'mind')
  assert.equal(undoInsert?.values?.[5], 'update')
  const beforeState = JSON.parse(String(undoInsert?.values?.[7]))
  const afterState = JSON.parse(String(undoInsert?.values?.[8]))
  assert.equal(beforeState.items['note:41'].content_plain, '旧正文')
  assert.equal(afterState.items['note:41'].content_plain, '新正文')
  assert.equal(state.statements.at(-1)?.sql, 'COMMIT')
  assert.equal(state.released, 1)
})

test('stale versions conflict and owner-hidden or soft-deleted notes stay 404', async () => {
  const stale = setup({ before: row({ version: 2 }) })
  await assert.rejects(
    stale.mutate.update('owner-a', 41, { version: 1, title: '旧写入' }, null),
    (error) => error instanceof MindNoteMutationError && error.statusCode === 409,
  )
  assert.equal(stale.statements.some((entry) => entry.sql.includes('UPDATE mind_nodes')), false)
  assert.equal(stale.statements.at(-1)?.sql, 'ROLLBACK')

  const hidden = setup({ before: null })
  await assert.rejects(
    hidden.mutate.delete('owner-a', 41, null),
    (error) => error instanceof MindNoteMutationError && error.statusCode === 404,
  )
  assert.equal(hidden.statements.some((entry) => entry.sql.includes('UPDATE mind_nodes')), false)
})

test('an empty PATCH returns the current note even when the supplied version is stale', async () => {
  const current = row({ version: 2 })
  const state = setup({ before: current })
  const result = await state.mutate.update('owner-a', 41, { version: 1 }, 'undo-a')
  assert.equal(result.changed, false)
  assert.equal(result.note.version, 2)
  assert.equal(state.statements.some((entry) => entry.sql.includes('UPDATE mind_nodes')), false)
  assert.equal(state.statements.some((entry) => entry.sql.includes('undo_operations')), false)
  assert.equal(state.statements.at(-1)?.sql, 'COMMIT')
})

test('note DELETE soft-deletes, increments version, and records the before/after Undo state', async () => {
  const state = setup({ before: row(), after: row({ deleted_at: now, version: 2, updated_at: now }) })
  await state.mutate.delete('owner-a', 41, 'undo-a')
  const update = state.statements.find((entry) => entry.sql.includes('UPDATE mind_nodes'))
  assert.match(update?.sql ?? '', /deleted_at = CURRENT_TIMESTAMP/)
  assert.match(update?.sql ?? '', /version = version \+ 1/)
  const undoInsert = state.statements.find((entry) => entry.sql.includes('INSERT INTO undo_operations'))
  assert.equal(undoInsert?.values?.[5], 'delete')
  assert.equal(JSON.parse(String(undoInsert?.values?.[7])).items['note:41'].deleted_at, null)
  assert.ok(JSON.parse(String(undoInsert?.values?.[8])).items['note:41'].deleted_at)
  assert.equal(state.statements.at(-1)?.sql, 'COMMIT')
})

test('an Undo failure rolls back a note mutation', async () => {
  const state = setup({ failUndo: true })
  await assert.rejects(state.mutate.update('owner-a', 41, {
    version: 1, title: '新标题',
  }, 'undo-a'), /synthetic undo failure/)
  assert.equal(state.statements.at(-1)?.sql, 'ROLLBACK')
})
