import assert from 'node:assert/strict'
import { test } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import type { MindDatabase } from '../../src/mind/note-postgres-sqlite.js'
import { tablesSql } from '../../src/data/schema.js'
import { contract } from '../fixtures/mind-note-contract.js'

test('SQLite 便签与 Undo 共同提交并在 Undo 失败时回滚', async () => {
  const connection = new SQLite(':memory:')
  connection.exec(`${tablesSql('sqlite').mindNodes};${tablesSql('sqlite').undo}`)
  const db = new Kysely<MindDatabase>({ dialect: new SqliteDialect({ database: connection }) })
  try { await contract(db, 'sqlite') } finally { await db.destroy() }
})

test('SQLite 独立连接等待写锁并发创建、恢复和删除默认关系', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fork } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { initializeSqlite } = await import('../../src/data/sqlite.js')
  const dir = await mkdtemp(join(tmpdir(), 'gugu-mind-sqlite-race-'))
  const path = join(dir, 'core.db')
  const children: ReturnType<typeof fork>[] = []
  let locker: SQLite.Database | undefined
  try {
    await initializeSqlite(path)
    locker = new SQLite(path)
    const owner = (locker.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").get() as { value: string }).value.replaceAll('-', '')
    const stamp = '2026-11-14 10:00:00.000000'
    locker.prepare('INSERT INTO mind_maps (id,user_id,title,project_id,data_json,created_at,updated_at,deleted_at) VALUES (1,?,?,NULL,?,?,?,NULL)').run(owner, '画布', '{}', stamp, stamp)
    const insertNode = locker.prepare("INSERT INTO mind_nodes (id,user_id,kind,title,content_md,content_plain,color,ref_type,ref_id,ref_snapshot,origin,indexed_at,indexed_hash,version,captured_at,created_at,updated_at,deleted_at) VALUES (?,?,'canvas_note',NULL,'','',NULL,NULL,NULL,NULL,'user',NULL,NULL,1,?,?,?,NULL)")
    const insertItem = locker.prepare("INSERT INTO mind_canvas_items (user_id,canvas_id,node_id,x,y,w,h,z,collapsed,data_json,created_at,updated_at,deleted_at) VALUES (?,1,?,0,0,NULL,NULL,0,0,'{}',?,?,NULL)")
    for (const id of [1, 2]) { insertNode.run(id, owner, stamp, stamp, stamp); insertItem.run(owner, id, stamp, stamp) }
    insertNode.run(3, owner, stamp, stamp, stamp)
    const workerPath = fileURLToPath(new URL('../fixtures/mind-relation-sqlite-worker.mjs', import.meta.url))
    const next = (child: ReturnType<typeof fork>) => new Promise<Record<string, unknown>>((resolve, reject) => { child.once('message', message => resolve(message as Record<string, unknown>)); child.once('error', reject) })
    for (let i = 0; i < 2; i++) { const child = fork(workerPath, [path], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child); assert.deepEqual(await next(child), { ready: true }) }
    async function race(command = 'run') {
      locker!.exec('BEGIN IMMEDIATE')
      const results = children.map(child => next(child))
      for (const child of children) child.send(command)
      await new Promise(resolve => setTimeout(resolve, 200))
      locker!.exec('COMMIT')
      return Promise.all(results)
    }
    const created = await race()
    assert.ok(created.every(result => typeof result.id === 'number' && Number(result.elapsed) >= 100), JSON.stringify(created))
    assert.equal(created[0]!.id, created[1]!.id)
    locker.prepare('UPDATE mind_relations SET deleted_at=? WHERE id=?').run(stamp, created[0]!.id)
    const restored = await race()
    assert.ok(restored.every(result => result.id === created[0]!.id && Number(result.elapsed) >= 100), JSON.stringify(restored))
    assert.deepEqual(locker.prepare('SELECT id, deleted_at FROM mind_relations').all(), [{ id: created[0]!.id, deleted_at: null }])
    const deleted = await race('delete')
    assert.equal(deleted.filter(result => result.id === created[0]!.id && Number(result.elapsed) >= 100).length, 1, JSON.stringify(deleted))
    assert.equal(deleted.filter(result => result.status === 404).length, 1, JSON.stringify(deleted))
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id='concurrent-delete'").get() as { count: number }).count, 1)
    assert.ok((locker.prepare('SELECT deleted_at FROM mind_relations WHERE id=1').get() as { deleted_at: string | null }).deleted_at)
    locker.prepare('UPDATE mind_relations SET deleted_at=NULL WHERE id=1').run()
    locker.exec("CREATE TRIGGER fail_delete_undo BEFORE INSERT ON undo_operations BEGIN SELECT RAISE(ABORT, 'test undo failure'); END")
    const rollbackResult = next(children[0]!)
    children[0]!.send('delete')
    assert.equal((await rollbackResult).status, null)
    assert.equal((locker.prepare('SELECT deleted_at FROM mind_relations WHERE id=1').get() as { deleted_at: string | null }).deleted_at, null)
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id='concurrent-delete'").get() as { count: number }).count, 1)

    locker.exec('DROP TRIGGER fail_delete_undo')
    const added = await race('add')
    assert.ok(added.every(result => typeof result.id === 'number' && Number(result.elapsed) >= 100), JSON.stringify(added))
    assert.equal(added[0]!.id, added[1]!.id)
    assert.equal((locker.prepare('SELECT count(*) AS count FROM mind_canvas_items WHERE canvas_id=1 AND node_id=3').get() as { count: number }).count, 1)
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id='concurrent-add'").get() as { count: number }).count, 1)
    locker.prepare('UPDATE mind_canvas_items SET deleted_at=? WHERE canvas_id=1 AND node_id=3').run(stamp)
    const restoredItem = await race('add')
    assert.ok(restoredItem.every(result => result.id === added[0]!.id && Number(result.elapsed) >= 100), JSON.stringify(restoredItem))
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id='concurrent-add'").get() as { count: number }).count, 2)
    locker.exec('BEGIN IMMEDIATE')
    const updateResults = children.map(child => next(child))
    children[0]!.send('update')
    children[1]!.send('front')
    await new Promise(resolve => setTimeout(resolve, 200))
    locker.exec('COMMIT')
    const [updateResult, frontResult] = await Promise.all(updateResults)
    assert.equal(updateResult!.id, 1)
    assert.equal(frontResult!.id, 2)
    assert.ok(Number(updateResult!.elapsed) >= 100 && Number(frontResult!.elapsed) >= 100)
    assert.deepEqual(locker.prepare('SELECT id,x,y,z FROM mind_canvas_items WHERE canvas_id=1 ORDER BY id').all(), [
      { id: 1, x: 55, y: 0, z: 1000 }, { id: 2, x: 66, y: 77, z: 3000 }, { id: 3, x: 0, y: 0, z: 2000 },
    ])
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id IN ('concurrent-update','concurrent-front')").get() as { count: number }).count, 2)
    const noteUpdates = await race('note-update')
    assert.equal(noteUpdates.filter(result => result.id === 3 && Number(result.elapsed) >= 100).length, 1, JSON.stringify(noteUpdates))
    assert.equal(noteUpdates.filter(result => result.status === 409).length, 1, JSON.stringify(noteUpdates))
    assert.equal((locker.prepare("SELECT count(*) AS count FROM undo_operations WHERE undo_context_id='concurrent-canvas-note'").get() as { count: number }).count, 1)
    assert.deepEqual(locker.prepare('SELECT title,version FROM mind_nodes WHERE id=3').get(), { title: '并发更新', version: 2 })



  } finally {
    if (locker?.inTransaction) locker.exec('ROLLBACK')
    locker?.close()
    await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.send('close') })))
    await rm(dir, { recursive: true, force: true })
  }
})
