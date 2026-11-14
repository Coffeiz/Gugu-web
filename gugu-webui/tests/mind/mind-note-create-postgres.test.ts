import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresMindNoteInserter } from '../../src/domains/mind/persistence/mind-note-create-postgres.js'

const now = new Date('2026-11-14T10:00:00.000Z')

test('note insert and Python-compatible Undo record commit atomically with a Mind snapshot', async () => {
  const statements: Array<{ sql: string; values?: unknown[] }> = []
  let released = 0
  const row = {
    id: '41', kind: 'note', title: '记录', content_md: '正文', content_plain: '正文',
    color: 'amber', captured_at: now, version: '1', created_at: now, updated_at: now,
    deleted_at: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user',
  }
  const client = {
    async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
      statements.push({ sql, values })
      return { rows: sql.includes('INSERT INTO mind_nodes') ? [row as T] : [] }
    },
    release() { released += 1 },
  }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  const insert = createPostgresMindNoteInserter(pool)

  const note = await insert('owner-a', {
    contentMd: '正文', contentPlain: '正文',
    indexedHash: 'hash', title: '记录', color: 'amber', capturedAt: now,
  }, 'undo-a')

  assert.equal(note.id, 41)
  assert.equal(released, 1)
  assert.equal(statements.length, 5)
  assert.equal(statements[0]?.sql, 'BEGIN')
  assert.match(statements[1]?.sql ?? '', /INSERT INTO mind_nodes/)
  assert.match(statements[2]?.sql ?? '', /UPDATE undo_operations/)
  assert.match(statements[3]?.sql ?? '', /INSERT INTO undo_operations/)
  assert.equal(statements[4]?.sql, 'COMMIT')
  const undoInsert = statements[3]?.values ?? []
  assert.equal(undoInsert[4], 'mind')
  assert.equal(undoInsert[5], 'create')
  assert.deepEqual(JSON.parse(String(undoInsert[6])), [{ kind: 'note', id: 41 }])
  assert.equal(JSON.parse(String(undoInsert[8])).items['note:41'].content_plain, '正文')
})

test('note insert rolls back when its in-transaction Undo write fails', async () => {
  const statements: string[] = []
  const client = {
    async query<T = Record<string, unknown>>(sql: string) {
      statements.push(sql)
      if (sql.includes('INSERT INTO undo_operations')) throw new Error('synthetic undo failure')
      return { rows: sql.includes('INSERT INTO mind_nodes') ? [{
        id: 41, kind: 'note', title: null, content_md: '', content_plain: '', color: null,
        captured_at: now, version: 1, created_at: now, updated_at: now, deleted_at: null,
        ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user',
      } as T] : [] }
    },
    release() {},
  }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  const insert = createPostgresMindNoteInserter(pool)

  await assert.rejects(insert('owner-a', {
    contentMd: '', contentPlain: '', indexedHash: 'hash', title: null, color: null, capturedAt: now,
  }, 'undo-a'), /synthetic undo failure/)
  assert.equal(statements.at(-1), 'ROLLBACK')
})
