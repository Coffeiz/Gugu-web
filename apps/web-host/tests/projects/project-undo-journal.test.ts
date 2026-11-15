import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendProjectUndoMove, recoverProjectUndoJournal, type ProjectUndoJournalStorage } from '../../src/domains/undo/persistence/project-journal.js'
import { createLocalProjectUndoJournalStorage } from '../../src/domains/undo/persistence/project-journal-local.js'

function fixture(status: string, paths: string[]) {
  const existing = new Set(paths), calls: string[] = []
  const journal = { id: 'j', user_id: 'owner', operation_id: 'op', before_status: 'active', after_status: 'undone', moves: [{ from: 'owner/a', to: 'owner/b' }] }
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.startsWith('SELECT id,user_id')) return { rows: [journal] }
    if (sql.startsWith('SELECT status')) return { rows: [{ status }] }
    return { rows: [] }
  }, release() {} }
  const storage: ProjectUndoJournalStorage = {
    async exists(_owner, key) { return existing.has(key) },
    async move(_owner, from, to) { assert.ok(existing.delete(from)); existing.add(to) },
  }
  return { pool: { connect: async () => client } as unknown as Pool, storage, calls, existing }
}

test('未提交时恢复源文件，已提交时完成目标移动', async () => {
  const pending = fixture('active', ['owner/b'])
  assert.equal(await recoverProjectUndoJournal(pending.pool, pending.storage), true)
  assert.deepEqual([...pending.existing], ['owner/a'])
  const committed = fixture('undone', ['owner/a'])
  assert.equal(await recoverProjectUndoJournal(committed.pool, committed.storage), true)
  assert.deepEqual([...committed.existing], ['owner/b'])
  assert.ok(committed.calls.includes('COMMIT'))
})

test('路径冲突时不覆盖文件且保留日志', async () => {
  const f = fixture('active', ['owner/a', 'owner/b'])
  await assert.rejects(() => recoverProjectUndoJournal(f.pool, f.storage))
  assert.equal(f.calls.some(sql => sql.startsWith('DELETE FROM project_undo_journals')), false)
  assert.ok(f.calls.includes('ROLLBACK'))
})

test('移动前追加日志必须确认记录仍存在', async () => {
  const pool = { async query() { return { rowCount: 0 } } } as unknown as Pick<Pool, 'query'>
  await assert.rejects(() => appendProjectUndoMove(pool, 'missing', { from: 'owner/a', to: 'owner/b' }))
  await assert.rejects(() => appendProjectUndoMove(pool, 'missing', { from: 'owner/a', to: 'owner/a' }))
})

test('Local 恢复不覆盖目标且拒绝符号链接', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-undo-recovery-'))
  try {
    await mkdir(path.join(root, 'owner'))
    await writeFile(path.join(root, 'owner', 'a'), '源')
    await writeFile(path.join(root, 'owner', 'b'), '目标')
    const storage = createLocalProjectUndoJournalStorage(root)
    await assert.rejects(() => storage.move('owner', 'owner/a', 'owner/b'))
    assert.equal(await readFile(path.join(root, 'owner', 'a'), 'utf8'), '源')
    assert.equal(await readFile(path.join(root, 'owner', 'b'), 'utf8'), '目标')
    await symlink(tmpdir(), path.join(root, 'owner', 'outside'))
    await assert.rejects(() => storage.exists('owner', 'owner/outside/a'))
    await assert.rejects(() => storage.exists('owner', '../outside'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
