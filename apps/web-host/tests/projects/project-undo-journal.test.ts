import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendProjectUndoMove, recoverProjectUndoJournal, type ProjectUndoJournalStorage } from '../../src/modules/undo/persistence/project-journal.js'
import { createLocalProjectUndoJournalStorage } from '../../src/modules/undo/persistence/project-journal-local.js'

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
    await symlink(tmpdir(), path.join(root, 'owner', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => storage.exists('owner', 'owner/outside/a'))
    await assert.rejects(() => storage.exists('owner', '../outside'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal 预检查后被创建的目标不会被覆盖，失败回滚并保留日志', async t => {
  for (const status of ['active', 'undone']) await t.test(status, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-journal-race-'))
    try {
      const f = fixture(status, [])
      const source = status === 'active' ? 'owner/b' : 'owner/a', target = status === 'active' ? 'owner/a' : 'owner/b'
      await mkdir(path.join(root, 'owner'))
      await writeFile(path.join(root, source), '待恢复原文')
      const storage = createLocalProjectUndoJournalStorage(root)
      const racing: ProjectUndoJournalStorage = {
        async exists(owner, key) {
          const result = await storage.exists(owner, key)
          if (key === target && !result) await writeFile(path.join(root, target), '并发目标', { flag: 'wx' })
          return result
        }, move: storage.move,
      }
      await assert.rejects(recoverProjectUndoJournal(f.pool, racing), { code: 'EEXIST' })
      assert.equal(await readFile(path.join(root, source), 'utf8'), '待恢复原文')
      assert.equal(await readFile(path.join(root, target), 'utf8'), '并发目标')
      assert.equal(f.calls.some(sql => sql.startsWith('DELETE FROM project_undo_journals')), false)
      assert.ok(f.calls.includes('ROLLBACK'))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

test('崩溃留下双硬链接时 journal 不猜测、不删除任一边并保留诊断记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-journal-half-move-'))
  try {
    await mkdir(path.join(root, 'owner'))
    await writeFile(path.join(root, 'owner/a'), '保留正文')
    await link(path.join(root, 'owner/a'), path.join(root, 'owner/b'))
    const f = fixture('active', []), storage = createLocalProjectUndoJournalStorage(root)
    await assert.rejects(recoverProjectUndoJournal(f.pool, storage), /路径状态不明确/)
    for (const key of ['owner/a', 'owner/b']) assert.equal(await readFile(path.join(root, key), 'utf8'), '保留正文')
    assert.equal((await stat(path.join(root, 'owner/a'))).ino, (await stat(path.join(root, 'owner/b'))).ino)
    assert.equal(f.calls.some(sql => sql.startsWith('DELETE FROM project_undo_journals')), false)
    assert.ok(f.calls.includes('ROLLBACK'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('journal 目录移动不支持时保留原目录和记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-journal-directory-'))
  try {
    await mkdir(path.join(root, 'owner/b'), { recursive: true })
    await writeFile(path.join(root, 'owner/b/正文'), '目录原文')
    const f = fixture('active', [])
    await assert.rejects(recoverProjectUndoJournal(f.pool, createLocalProjectUndoJournalStorage(root)), { code: 'ENOTSUP' })
    assert.equal(await readFile(path.join(root, 'owner/b/正文'), 'utf8'), '目录原文')
    assert.equal(f.calls.some(sql => sql.startsWith('DELETE FROM project_undo_journals')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
