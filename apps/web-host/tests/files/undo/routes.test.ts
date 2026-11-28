import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../../src/app.js'
import { createHostCoreUndoOperations } from '../../../src/modules/undo/service.js'
import { createLocalFileUndoStorage } from '../../../src/modules/files/storage/undo.js'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { signedUserToken } from '../../helpers/auth.js'

const secret = 'synthetic-file-undo-secret'

test('认证文件 Undo 路由经 Core SQLite 事务恢复正文、版本并支持重做', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-file-undo-'))
  const databasePath = path.join(directory, 'core.db')
  const storageRoot = path.join(directory, 'storage')
  await initializeSqlite(databasePath)
  const { runtime, ownerId } = await openSqliteRuntime(databasePath)
  const ownerKey = ownerId.replaceAll('-', '')
  const db = runtime.db as any
  const executeRaw = (statement: string) => db.executeQuery({ sql: statement, parameters: [], query: { kind: 'RawNode', sqlFragments: [statement], parameters: [] } })
  const fileKey = `${ownerId}/个人文件/内容.md`
  const fileHash = (await import('node:crypto')).createHash('sha256').update(fileKey).digest('hex').slice(0, 24)
  const artifactPrefix = `${ownerId}/.undo/op-${'a'.repeat(32)}/file-${fileHash}`
  const fileRef = `file:${fileKey}`
  try {
    await db.schema.createTable('files')
      .addColumn('user_id', 'text', (column: any) => column.notNull())
      .addColumn('display_name', 'text')
      .addColumn('ext', 'text')
      .addColumn('path', 'text')
      .addColumn('version', 'integer', (column: any) => column.notNull())
      .addColumn('size', 'text')
      .addColumn('size_bytes', 'integer')
      .addColumn('mime_type', 'text')
      .addColumn('deleted_at', 'text')
      .addPrimaryKeyConstraint('files_pkey', ['user_id', 'path'])
      .execute()
    await db.insertInto('files').values({ user_id: ownerKey, display_name: '内容', ext: 'md', path: fileKey, version: 2, size: '9 B', size_bytes: 9, mime_type: 'text/markdown', deleted_at: null }).execute()
    const before = { items: { [fileRef]: { display_name: '内容', ext: 'md', path: fileKey, version: 1, size: '9 B', size_bytes: 9 } } }
    const after = { items: { [fileRef]: { display_name: '内容', ext: 'md', path: fileKey, version: 2, size: '9 B', size_bytes: 9 } } }
    await db.insertInto('undo_operations').values({
      id: 'op', user_id: ownerKey, undo_context_id: 'editor', group_id: 'group', resource: 'files', action: 'update',
      target_refs: JSON.stringify([{ kind: 'file', path: fileKey }]), before_state: JSON.stringify(before), after_state: JSON.stringify(after),
      base_versions: '{}', artifact_refs: JSON.stringify({ [fileRef]: { before_key: `${artifactPrefix}/before`, after_key: `${artifactPrefix}/after` } }),
      actor_type: 'web', status: 'active', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), undone_at: null, failure_code: null,
    }).execute()
    await mkdir(path.join(storageRoot, path.dirname(fileKey)), { recursive: true })
    await mkdir(path.join(storageRoot, path.dirname(`${artifactPrefix}/before`)), { recursive: true })
    await writeFile(path.join(storageRoot, fileKey), '新正文')
    await writeFile(path.join(storageRoot, `${artifactPrefix}/before`), '旧正文')
    await writeFile(path.join(storageRoot, `${artifactPrefix}/after`), '新正文')

    const events: Record<string, unknown>[] = []
    const storage = createLocalFileUndoStorage(storageRoot)
    const app = createApp({
      appName: 'Gugu', isReady: async () => true,
      userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
      undo: createHostCoreUndoOperations({} as Pool, createRuntimeUndoTransactionPort(runtime), async (_owner, event) => { events.push(event) }, undefined, storage),
    })
    try {
      const auth = { authorization: `Bearer ${signedUserToken(secret, ownerId)}` }
      const foreign = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: { authorization: `Bearer ${signedUserToken(secret, '22222222-2222-4222-8222-222222222222')}` }, payload: { operation_id: 'op', context_id: 'editor' } })
      assert.equal(foreign.statusCode, 404)
      assert.equal(await readFile(path.join(storageRoot, fileKey), 'utf8'), '新正文')
      const undo = await app.inject({ method: 'POST', url: '/api/v1/undo', headers: auth, payload: { operation_id: 'op', context_id: 'editor' } })
      assert.equal(undo.statusCode, 200)
      assert.equal(await readFile(path.join(storageRoot, fileKey), 'utf8'), '旧正文')
      assert.equal((await db.selectFrom('files').select('version').where('path', '=', fileKey).executeTakeFirst()).version, 3)

      await executeRaw("CREATE TRIGGER fail_file_undo_update BEFORE UPDATE ON files BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
      const failedRedo = await app.inject({ method: 'POST', url: '/api/v1/undo/redo', headers: auth, payload: { operation_id: 'op', context_id: 'editor' } })
      assert.equal(failedRedo.statusCode, 500)
      assert.equal(await readFile(path.join(storageRoot, fileKey), 'utf8'), '旧正文')
      assert.equal((await db.selectFrom('files').select('version').where('path', '=', fileKey).executeTakeFirst()).version, 3)
      await executeRaw('DROP TRIGGER fail_file_undo_update')

      const redo = await app.inject({ method: 'POST', url: '/api/v1/undo/redo', headers: auth, payload: { operation_id: 'op', context_id: 'editor' } })
      assert.equal(redo.statusCode, 200)
      assert.equal(await readFile(path.join(storageRoot, fileKey), 'utf8'), '新正文')
      assert.equal((await db.selectFrom('files').select('version').where('path', '=', fileKey).executeTakeFirst()).version, 4)
      assert.deepEqual(events.map(event => event.operation), ['update', 'update'])
    } finally { await app.close() }
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
