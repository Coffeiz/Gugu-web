import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/modules/agent/tools/registry.js'
import { createWebScheduledAttachmentResources } from '../../src/modules/scheduled-tasks/delivery/files.js'

test('send_file 实际 Host adapter 读取 owner 文件，阻断越界路径和失效 lease 暂存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-send-file-'))
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '9', runId: 'send-file-run' }
  const relativePath = `${ownerId}/personal/report.txt`
  let leaseCurrent = false, staged = 0
  let core: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await mkdir(join(root, ownerId, 'personal'), { recursive: true })
    await writeFile(join(root, relativePath), 'safe', 'utf8')
    const databasePath = join(root, 'core.db')
    await initializeSqlite(databasePath)
    core = (await openSqliteRuntime(databasePath)).runtime
    await core.db.schema.createTable('files').addColumn('id', 'integer', column => column.primaryKey())
      .addColumn('user_id', 'text', column => column.notNull()).addColumn('display_name', 'text', column => column.notNull())
      .addColumn('ext', 'text').addColumn('size_bytes', 'integer', column => column.notNull().defaultTo(4))
      .addColumn('storage_key', 'text', column => column.notNull()).addColumn('storage_backend', 'text', column => column.notNull())
      .addColumn('space', 'text', column => column.notNull()).addColumn('folder_id', 'integer').addColumn('deleted_at', 'text').execute()
    await core.db.insertInto('files').values({ id: 23, user_id: ownerId, display_name: 'report', ext: 'txt', size_bytes: 4,
      storage_key: relativePath, storage_backend: 'local', space: 'personal', folder_id: null, deleted_at: null }).execute()
    if (!core) throw new Error('SQLite 测试 Core 初始化失败')
    const resources = createWebScheduledAttachmentResources(core as never, root,
      async () => { throw new Error('此用例不读取聊天附件') }, {
        open: async () => ({ status: 200, headers: { 'content-type': 'image/png' },
          body: (async function* () { yield new Uint8Array([1, 2, 3]) })(), async cancel() {} }),
        async stage(owner, input) {
          assert.equal(owner, ownerId)
          assert.equal(input.name, '图片')
          assert.equal(input.ext, 'png')
          assert.equal(Buffer.from(await readFile(input.path)).toString('hex'), '010203')
          staged++
          return { attach_id: `staged-${staged}`, img_width: 1, img_height: 1 }
        },
      })
    const registry = createAgentToolRegistry({ core: {} as never, sendFile: resources.toolForRun(async () => leaseCurrent),
      authorize: async (current, name) => current.ownerId === ownerId && name === 'send_file' })
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不允许执行宿主 Shell') } }

    const file = await registry.tools.dispatch({ id: 'file', name: 'send_file', input: { file_id: 23 } }, scope)
    assert.equal(file.kind, 'completed')
    if (file.kind === 'completed') {
      assert.equal(file.successful, true, JSON.stringify(file))
      assert.deepEqual(file.artifact, { file_id: 23, name: 'report', ext: 'txt', size_bytes: 4 })
    }

    await core.db.updateTable('files').set({ storage_key: '../outside.txt' }).where('id', '=', 23).execute()
    const escaped = await registry.tools.dispatch({ id: 'unsafe', name: 'send_file', input: { file_id: 23 } }, scope)
    assert.equal(escaped.kind, 'completed')
    if (escaped.kind === 'completed') {
      assert.equal(escaped.successful, false)
      assert.equal((escaped.value as { error?: unknown }).error, '文件不存在')
    }

    const stale = await registry.tools.dispatch({ id: 'stale', name: 'send_file', input: { url: 'https://images.example/safe.png' } }, scope)
    assert.equal(stale.kind, 'completed')
    if (stale.kind === 'completed') assert.equal(stale.successful, false)
    assert.equal(staged, 0)

    leaseCurrent = true
    const current = await registry.tools.dispatch({ id: 'current', name: 'send_file', input: { url: 'https://images.example/safe.png' } }, scope)
    assert.equal(current.kind, 'completed', JSON.stringify({ current, staged }))
    if (current.kind === 'completed') {
      assert.equal(current.successful, true)
      assert.deepEqual(current.artifact, { attach_id: 'staged-1', name: '图片', ext: 'png', size_bytes: 3,
        kind: 'image', img_width: 1, img_height: 1 })
    }
    assert.equal(staged, 1)
  } finally { await core?.close(); await rm(root, { recursive: true, force: true }) }
})
