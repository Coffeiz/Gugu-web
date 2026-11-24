import { createOwnerFileTools } from '../../../../src/modules/agent/tools/owner.js'
import { createViewImageTool } from '../../../../src/modules/agent/tools/files/image.js'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry, filterConfiguredWebAgentTools } from '../../../../src/modules/agent/tools/registry.js'
import { createAgentDiskTrashTools } from '../../../../src/modules/agent/tools/trash/disk.js'

type Options = Parameters<typeof createAgentDiskTrashTools>[0]
const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'test-trash' }
test('没有 Shell 和目录授权时按账号路径回收真实文件，确认收据一次使用，且恢复和清空均凭回收站路径', {
  skip: process.platform !== 'linux' && '需要 Linux 磁盘回收站',
}, async t => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-path-trash-'))
  t.after(() => rm(storageRoot, { recursive: true, force: true }))
  const root = identity.ownerId + '/个人文件'
  await mkdir(join(storageRoot, root), { recursive: true })
  const file = join(storageRoot, root, '小北.txt')
  await writeFile(file, '回收后需恢复原始内容')

  const accepted = new Map<string, string>()
  const consumed = new Set<unknown>()
  const gate = {
    async prepare(call: { id: string }, _scope: unknown, args: string, target: { versionsDigest: string }) {
      accepted.set(call.id, args + target.versionsDigest)
      return { ok: true, value: { id: call.id, kind: 'confirmation', toolCall: call } }
    },
    async verify(call: { id: string }, _scope: unknown, args: string, target: { versionsDigest: string }) {
      return accepted.get(call.id) === args + target.versionsDigest ? { ok: true, value: call.id } : { ok: false }
    },
  }
  const confirmation = { gate } as unknown as Options['confirmations']['delete_item']
  let authorized = true
  let authorizationFailure = false
  let abortDuringAuthorization: AbortController | null = null
  const ownerTools = createOwnerFileTools({
    viewImage: createViewImageTool({ authorize: async () => false, supportsImage: async () => false, mount: async () => null,
      async open() { throw new Error('本测试不读取图片') } }),
    async read() { return null },
    async mounts() { throw new Error('回收站不得创建 Shell 挂载') },
    trash: {
      async authorize(candidate) {
        if (authorizationFailure) throw new Error('synthetic-private-credential')
        abortDuringAuthorization?.abort()
        return authorized && candidate.ownerId === identity.ownerId
      },
      async currentDirectory() { return null },
      storageRoot, pool: { query: (async (sql: string, args: unknown[]) => {
        if (sql.includes('FROM projects')) {
          assert.deepEqual(args, [42, identity.ownerId])
          return { rows: [] }
        }
        if (sql.includes('FROM workspace_directories')) {
          assert.deepEqual(args, [identity.ownerId, '其他账号工作区'])
          return { rows: [] }
        }
        throw new Error('个人磁盘回收操作不应访问旧文件表')
      }) as Options['pool']['query'] },
      confirmations: { delete_item: confirmation, restore_file: confirmation, restore_folder: confirmation, permanent_delete: confirmation },
      async claim(_confirmation, reference) {
        if (consumed.has(reference)) return false
        consumed.add(reference)
        return true
      },
    },
  })
  const toolNames = ownerTools.diskTrashTools!.map(tool => tool.definition.name)
  assert.deepEqual(filterConfiguredWebAgentTools(toolNames), toolNames)
  const registry = createAgentToolRegistry({
    core: {} as SqlDataRuntime, ...ownerTools,
    async authorize(owner, name) { return owner.ownerId === identity.ownerId && toolNames.includes(name) },
  })
  assert.deepEqual((await registry.capabilities(identity)).map(tool => tool.name).sort(), [...toolNames].sort())
  const scope = { identity, roundId: 'round-1', signal: new AbortController().signal,
    async execute(): Promise<never> { throw new Error('磁盘回收站不执行 Shell') } }
  const call = (name: string, input: object, id: string, confirmed = false) => registry.tools.dispatch({ name, input, id }, {
    ...scope, resolution: confirmed ? { interactionId: id, receiptId: id, status: 'confirmed', value: null } : null,
  })
  const path = '/personal/小北.txt'
  for (const invalid of ['/personal', '/personal/../workspace/default/小北.txt', '小北.txt',
    '/project/其他账号项目 #42/小北.txt', '/workspace/其他账号工作区/小北.txt']) {
    const result = await call('delete_item', { path: invalid, kind: 'file' }, 'invalid')
    assert.equal(result.kind === 'completed' && result.successful, false)
  }
  assert.notEqual((await call('delete_item', { path: '/etc/example', kind: 'file' }, 'outside')).kind, 'waiting')
  assert.equal((await call('delete_item', { path, kind: 'file' }, 'stale')).kind, 'waiting')
  await writeFile(file, '确认后内容发生变化')
  const stale = await call('delete_item', { path, kind: 'file' }, 'stale', true)
  assert.equal(stale.kind === 'completed' && stale.successful, false)
  assert.equal(await readFile(file, 'utf8'), '确认后内容发生变化')

  assert.equal((await call('delete_item', { path, kind: 'file' }, 'delete')).kind, 'waiting')
  const deleted = await call('delete_item', { path, kind: 'file' }, 'delete', true)
  assert.ok(deleted.kind === 'completed' && deleted.successful)
  assert.match((deleted.value as { path: string }).path, /^\/trash\/[0-9a-f-]+$/)
  const trash = (deleted.value as { path: string }).path
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  authorized = false
  const denied = await call('list_trash', {}, 'denied')
  assert.equal(denied.kind === 'completed' && denied.successful, false)
  authorized = true
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(registry.tools.dispatch({ id: 'pre-cancel', name: 'list_trash', input: {} }, { ...scope, signal: cancelled.signal, resolution: null }))
  const during = new AbortController()
  abortDuringAuthorization = during
  await assert.rejects(registry.tools.dispatch({ id: 'during-cancel', name: 'list_trash', input: {} }, { ...scope, signal: during.signal, resolution: null }))
  abortDuringAuthorization = null
  authorizationFailure = true
  const failed = await call('list_trash', {}, 'failure')
  assert.ok(failed.kind === 'completed' && !failed.successful)
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-credential/)
  authorizationFailure = false
  const listed = await call('list_trash', {}, 'list')
  assert.ok(listed.kind === 'completed' && listed.successful)
  assert.equal((listed.value as { items: { path: string }[] }).items[0]!.path, trash)

  assert.equal((await call('restore_file', { path: trash }, 'restore')).kind, 'waiting')
  const restored = await call('restore_file', { path: trash }, 'restore', true)
  assert.equal(restored.kind === 'completed' && restored.successful, true)
  assert.equal(await readFile(file, 'utf8'), '确认后内容发生变化')
  const replay = await call('delete_item', { path, kind: 'file' }, 'delete', true)
  assert.equal(replay.kind === 'completed' && replay.successful, false)
  assert.equal(await readFile(file, 'utf8'), '确认后内容发生变化')

  assert.equal((await call('delete_item', { path, kind: 'file' }, 'delete-again')).kind, 'waiting')
  const second = await call('delete_item', { path, kind: 'file' }, 'delete-again', true)
  assert.ok(second.kind === 'completed' && second.successful)
  const purge = { path: (second.value as { path: string }).path }
  assert.equal((await call('permanent_delete', purge, 'purge')).kind, 'waiting')
  const purged = await call('permanent_delete', purge, 'purge', true)
  assert.equal(purged.kind === 'completed' && purged.successful, true)
  const empty = await call('list_trash', {}, 'empty')
  assert.ok(empty.kind === 'completed' && empty.successful)
  assert.deepEqual((empty.value as { items: unknown[] }).items, [])

  await writeFile(file, '并发删除保护')
  assert.equal((await call('delete_item', { path, kind: 'file' }, 'concurrent')).kind, 'waiting')
  const concurrent = await Promise.all([
    call('delete_item', { path, kind: 'file' }, 'concurrent', true),
    call('delete_item', { path, kind: 'file' }, 'concurrent', true),
  ])
  assert.equal(concurrent.filter(result => result.kind === 'completed' && result.successful).length, 1)
  const concurrentTrash = await call('list_trash', {}, 'after-concurrent')
  assert.ok(concurrentTrash.kind === 'completed' && concurrentTrash.successful)
  assert.equal((concurrentTrash.value as { items: unknown[] }).items.length, 1)
  assert.equal((await call('permanent_delete', { all: true }, 'clear-concurrent')).kind, 'waiting')
  const clearedConcurrent = await call('permanent_delete', { all: true }, 'clear-concurrent', true)
  assert.ok(clearedConcurrent.kind === 'completed' && clearedConcurrent.successful)

  const noItems = await call('permanent_delete', { all: true }, 'empty-trash')
  assert.ok(noItems.kind === 'completed' && noItems.successful && !noItems.mutated)

  async function recycle(name: string, key: string) {
    await writeFile(join(storageRoot, root, name), name)
    const input = { path: '/personal/' + name, kind: 'file' }
    assert.equal((await call('delete_item', input, key)).kind, 'waiting')
    const result = await call('delete_item', input, key, true)
    assert.ok(result.kind === 'completed' && result.successful)
    return (result.value as { path: string }).path
  }

  const first = await recycle('小北.txt', 'recycle-first')
  assert.equal((await call('permanent_delete', { all: true }, 'clear-stale')).kind, 'waiting')
  const late = await recycle('小南.txt', 'recycle-late')
  const changed = await call('permanent_delete', { all: true }, 'clear-stale', true)
  assert.equal(changed.kind === 'completed' && changed.successful, false)
  const preserved = await call('list_trash', {}, 'preserved')
  assert.ok(preserved.kind === 'completed' && preserved.successful)
  assert.deepEqual(new Set((preserved.value as { items: { path: string }[] }).items.map(item => item.path)), new Set([first, late]))

  const extra = await recycle('小西.txt', 'recycle-extra')
  const batch = { paths: [first, late] }
  assert.equal((await call('permanent_delete', batch, 'batch')).kind, 'waiting')
  const batchResult = await call('permanent_delete', batch, 'batch', true)
  assert.ok(batchResult.kind === 'completed' && batchResult.successful)
  assert.equal((batchResult.value as { deleted_count: number }).deleted_count, 2)
  const remaining = await call('list_trash', {}, 'remaining')
  assert.ok(remaining.kind === 'completed' && remaining.successful)
  assert.deepEqual((remaining.value as { items: { path: string }[] }).items.map(item => item.path), [extra])
  assert.equal((await call('permanent_delete', { all: true }, 'clear')).kind, 'waiting')
  const cleared = await call('permanent_delete', { all: true }, 'clear', true)
  assert.ok(cleared.kind === 'completed' && cleared.successful)
  const final = await call('list_trash', {}, 'after-clear')
  assert.ok(final.kind === 'completed' && final.successful)
  assert.deepEqual((final.value as { items: unknown[] }).items, [])

})
