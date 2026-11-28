import { test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createRuntimeUndoTransactionPort, createUndoStateMachine } from '../../src/undo/state-machine.js'
import { sql } from 'kysely'
import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { runtimeOperationContract } from './runtime-operation.fixture.js'
import { contract } from './state-machine.fixture.js'

test('正式 SQLite Mind Undo 状态机和跨资源预览', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-undo-sqlite-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try { await contract(runtime.db, 'sqlite', ownerId, createRuntimeUndoTransactionPort(runtime)); await runtimeOperationContract(runtime, ownerId) } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('正式 SQLite 独立进程并发认领只执行一次', async () => {
  const { fork } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const dir = await mkdtemp(join(tmpdir(), 'gugu-undo-race-')), path = join(dir, 'core.db')
  const children: ReturnType<typeof fork>[] = []
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path), db = runtime.db, key = ownerId.replaceAll('-', '')
    const stamp = '2026-01-01 00:00:00.000000'
    await db.insertInto('mind_nodes').values({ id: 1, user_id: key, kind: 'note', title: '并发', content_md: '', content_plain: '', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp, deleted_at: null }).execute()
    const snapshot = { kind: 'note', title: '并发', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
    await db.insertInto('undo_operations').values({ id: 'race', user_id: key, undo_context_id: 'race', group_id: 'race', resource: 'mind', action: 'create', target_refs: '[1]', before_state: '{}', after_state: JSON.stringify({ items: { 'note:1': snapshot } }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: stamp, undone_at: null, expires_at: null, failure_code: null }).execute()
    await runtime.close()
    const next = (child: ReturnType<typeof fork>) => new Promise<any>((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`worker exit ${code}`)) }) })
    for (let i = 0; i < 2; i++) {
      const child = fork(fileURLToPath(new URL('./state-machine-worker.ts', import.meta.url)), [path], { execPath: join(process.cwd(), 'node_modules/.bin/tsx'), execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      children.push(child)
      assert.deepEqual(await next(child), { ready: true })
    }
    const locker = new SQLite(path)
    locker.exec('BEGIN IMMEDIATE')
    const started = children.map(next)
    for (const child of children) child.send('locked')
    assert.deepEqual(await Promise.all(started), [{ started: true }, { started: true }])
    let completed = 0
    const results = children.map(child => next(child).then(result => { completed++; return result }))
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(completed, 0)
    locker.exec('COMMIT')
    locker.close()
    assert.deepEqual((await Promise.all(results)).sort((a, b) => Number(a.idempotent) - Number(b.idempotent)), [{ idempotent: false, events: 1 }, { idempotent: true, events: 0 }])
  } finally {
    for (const child of children) if (child.connected) child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})

test('正式 SQLite 写入失败回滚，通知失败发生在提交后且重试不重复通知', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-undo-failure-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path), db = runtime.db, key = ownerId.replaceAll('-', '')
    try {
      const stamp = '2026-01-01 00:00:00.000000'
      await db.insertInto('mind_nodes').values({ id: 1, user_id: key, kind: 'note', title: '测试', content_md: '', content_plain: '', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'user', indexed_at: null, indexed_hash: null, version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp, deleted_at: null }).execute()
      const snapshot = { kind: 'note', title: '测试', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
      await db.insertInto('undo_operations').values({ id: 'failure', user_id: key, undo_context_id: 'ctx', group_id: 'failure', resource: 'mind', action: 'create', target_refs: '[1]', before_state: '{}', after_state: JSON.stringify({ items: { 'note:1': snapshot } }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: stamp, undone_at: null, expires_at: null, failure_code: null }).execute()
      let notifications = 0
      const api = createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => { notifications++; throw new Error('通知失败') })
      await sql.raw("CREATE TRIGGER undo_test_failure BEFORE UPDATE ON undo_operations BEGIN SELECT RAISE(ABORT, '写入失败'); END").execute(db)
      await assert.rejects(api.apply(ownerId, 'ctx', 'failure', 'undo'), /写入失败/)
      assert.equal((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null)
      assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'failure').executeTakeFirstOrThrow()).status, 'active')
      assert.equal(notifications, 0)
      await sql.raw('DROP TRIGGER undo_test_failure').execute(db)
      await assert.rejects(api.apply(ownerId, 'ctx', 'failure', 'undo'), /通知失败/)
      assert.ok((await db.selectFrom('mind_nodes').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at)
      assert.equal((await db.selectFrom('undo_operations').selectAll().where('id', '=', 'failure').executeTakeFirstOrThrow()).status, 'undone')
      assert.equal(notifications, 1)
      assert.equal((await api.apply(ownerId, 'ctx', 'failure', 'undo')).idempotent, true)
      assert.equal(notifications, 1)
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
