import { prepareDesktopOwnerFiles } from '../../../packages/core/src/runtime/desktop-owner-files.js'
import { stageSkillPackage } from '../../../packages/core/src/agent/skills/package-stage.js'
import { createUserSkillBundle, listUserSkillBundles } from '../../../packages/core/src/agent/skills/bundle-store.js'
import { createDesktopClawHubInstaller, createDesktopFileSkillCreator } from '../src/main/mcp/clawhub-install.js'
import { skillPackageDigest } from '../../../packages/core/src/agent/skills/package-digest.js'
import { resourceHandlers } from '../src/main/mcp/ipc.js'
import type { IpcHost } from '../src/main/ipc/types.js'
import { createProjectWorkspaceBindingTool } from '../../../packages/core/src/agent/tools/workspaces/index.js'
import { createToolRegistry } from '../../../packages/core/src/agent/tools/registry.js'
import { shouldOpenFileInSystem } from '@gugu/desktop-contracts/file-preview'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { desktopFiles } from '../src/main/files/ipc'
import { resolveDesktopChatReferences } from '../../../packages/core/src/agent/sessions/desktop-references.js'
import { readDroppedFileExcerpt } from '../../../packages/core/src/runtime/desktop-file-excerpt.js'
import { createDesktopAppearanceService } from '../../../packages/core/src/preferences/desktop-appearance.js'
import { desktopHostAuthorization } from '../../../packages/core/src/runtime/desktop-shell.js'

let directory: string
let files: ReturnType<typeof desktopFiles>
const call = (command: unknown) => files.handlers[DESKTOP_CHANNELS.files]!(command)
let picked: string | undefined
let trashFailure: boolean
let trashed: string[]
const native = {
  async save() { return undefined },
  reveal() {},
  async open(_path: string) { return '' },
  async pickDirectory() { return picked },
  async trash(path: string) {
    trashed.push(path)
    if (trashFailure) throw new Error('合成系统错误')
    await rename(path, join(directory, `系统回收站测试项-${trashed.length}`))
  },
}
const createFiles = () => desktopFiles(join(directory, 'Gugu-data'), native, join(directory, 'app', 'workspaces.json'), join(directory, 'app'))
const bytes = (text: string) => new TextEncoder().encode(text)

it('安装技能包后可以通过文件历史撤销重做，且不会覆盖已有技能', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  const payload = new Map([['SKILL.md', bytes('---\nname: 示例\ndescription: 描述\n---\n正文')],
    ['references/info.md', bytes('资料')]])
  const install = () => stageSkillPackage({ dataRoot: directory, ownerId: owner, slug: 'sample', files: payload,
    signal: new AbortController().signal, commit: input => service.installSkillPackage(input.stagedDirectory, input.slug) })
  const target = join(directory, owner, '.agent', 'skills', 'sample')
  await install()
  expect(await readFile(join(target, 'references/info.md'), 'utf8')).toBe('资料')
  await expect(install()).rejects.toThrow()
  const execute = service.handlers[DESKTOP_CHANNELS.files]!
  await writeFile(join(target, 'references/info.md'), '后来修改')
  await expect(execute({ action: 'undo-trash', directoryId: 'skill-packages' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(join(target, 'references/info.md'), 'utf8')).toBe('后来修改')
  await writeFile(join(target, 'references/info.md'), '资料')
  expect(await execute({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  await expect(readFile(join(target, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await execute({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(join(target, 'references/info.md'), 'utf8')).toBe('资料')
})

it('桌面资源接口下载并安装技能包，安装操作进入文件撤销历史', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), { ...native, async trash() { throw new Error('技能删除应移动整个目录到应用撤销存储') } })
  const installer = createDesktopClawHubInstaller({ dataRoot: directory, ownerId: owner,
    commit: service.installSkillPackage,
    async download(reference) {
      expect(reference).toBe('sample/demo')
      return new Map([['SKILL.md', bytes('---\nname: 示例\ndescription: 描述\n---\n正文')],
        ['references/a.md', bytes('参考')]])
    } })
  const handler = resourceHandlers({ request: async () => { throw new Error('不应查询旧技能表') } } as unknown as IpcHost,
    undefined, installer, () => listUserSkillBundles(directory, owner), service.updateSkillDocument, service.deleteSkillPackage,
    mode => service.handlers[DESKTOP_CHANNELS.files]!({ action: mode === 'undo' ? 'undo-trash' : 'redo-trash', directoryId: 'skill-packages' }) as Promise<{ changed: boolean }>)[DESKTOP_CHANNELS.resources]!
  await expect(handler({ domain: 'skills', action: 'list' } as never)).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(handler({ domain: 'skills', action: 'create', fields: {} } as never)).rejects.toMatchObject({ code: 'invalid_request' })
  expect(await handler({ domain: 'skills', action: 'clawhub-install', reference: 'sample/demo' })).toEqual({ id: 'demo' })
  const target = join(directory, owner, '.agent', 'skills', 'demo')
  expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('参考')
  expect(await handler({ domain: 'skills', action: 'file-list', offset: 0 }))
    .toMatchObject({ skills: [{ id: 'demo', name: '示例', storage_kind: 'file' }], nextOffset: null })
  const digest = (await listUserSkillBundles(directory, owner)).skills[0]!.content_digest
  expect(await handler({ domain: 'skills', action: 'file-update', id: 'demo', expectedDigest: digest, patch: { enabled: false } }))
    .toEqual({ id: 'demo' })
  expect((await listUserSkillBundles(directory, owner)).skills[0]?.enabled).toBe(false)
  expect(await service.handlers[DESKTOP_CHANNELS.files]!({ action: 'undo-trash', directoryId: 'skill-packages' }))
    .toEqual({ changed: true })
  const restoredDigest = (await listUserSkillBundles(directory, owner)).skills[0]!.content_digest
  expect(await handler({ domain: 'skills', action: 'file-delete', id: 'demo', expectedDigest: restoredDigest })).toEqual({ id: 'demo' })
  await expect(readFile(join(target, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(target, 'references/a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await listUserSkillBundles(directory, owner)).skills).toEqual([])
  expect(await handler({ domain: 'skills', action: 'file-history', mode: 'undo' })).toEqual({ changed: true })
  expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('参考')
  expect(await handler({ domain: 'skills', action: 'file-history', mode: 'redo' })).toEqual({ changed: true })
  await expect(readFile(join(target, 'references/a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('桌面新建技能通过文件历史撤销和重做', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  const create = createDesktopFileSkillCreator({ dataRoot: directory, ownerId: owner,
    commit: service.installSkillPackage, async tools() { return new Set(['read_file']) } })
  const handler = resourceHandlers({ request: async () => { throw new Error('不应查询旧技能表') } } as unknown as IpcHost,
    undefined, undefined, undefined, undefined, undefined, undefined, create)[DESKTOP_CHANNELS.resources]!
  const fields = { name: '示例', description_short: '描述', description_long: null, category: 'personal',
    body: '正文', related_tools: ['read_file'], enabled: true }
  const result = await handler({ domain: 'skills', action: 'file-create', fields }) as { id: string }
  const target = join(directory, owner, '.agent', 'skills', result.id, 'SKILL.md')
  expect(await readFile(target, 'utf8')).toContain('正文')
  expect((await listUserSkillBundles(directory, owner)).skills[0]).toMatchObject({ name: '示例', related_tools: ['read_file'] })
  const history = service.handlers[DESKTOP_CHANNELS.files]!
  expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await history({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(target, 'utf8')).toContain('正文')
})

it('Agent 已提交技能操作可登记到桌面文件历史并去重', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  const original = '---\nname: 示例\ndescription: 描述\n---\n初版'
  const changed = '---\nname: 示例\ndescription: 描述\n---\n新版'
  const bundle = await createUserSkillBundle(directory, owner, 'demo', original)
  const install = { operationId: '00000000-0000-4000-8000-000000000001', slug: 'demo', action: 'install',
    before: null, after: original, packageDigest: await skillPackageDigest(bundle.path) }
  expect(await service.agentRecordSkillHistory(install)).toEqual({ recorded: true })
  expect(await service.agentRecordSkillHistory(install)).toEqual({ recorded: false })
  await expect(service.agentRecordSkillHistory({ ...install, after: '不同内容' })).rejects.toMatchObject({ code: 'conflict' })
  await writeFile(join(bundle.path, 'SKILL.md'), changed)
  const edit = { operationId: '00000000-0000-4000-8000-000000000002', slug: 'demo', action: 'update', before: original, after: changed, packageDigest: null }
  await expect(service.agentRecordSkillHistory({ ...edit, after: '不符' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await service.agentRecordSkillHistory(edit)).toEqual({ recorded: true })
  const history = service.handlers[DESKTOP_CHANNELS.files]!
  expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(join(bundle.path, 'SKILL.md'), 'utf8')).toBe(original)
  expect(await history({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(join(bundle.path, 'SKILL.md'), 'utf8')).toBe(changed)
  expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await service.agentRecordSkillHistory(install)).toEqual({ recorded: false })
})

it('桌面 Agent 技能收据提交后进入文件撤销栈', async () => {
  const { initializeSqlite, openSqliteRuntime } = await import('../../../packages/core/src/data/sqlite.js')
  const { createDurableFileSkillManagementPort } = await import('../../../packages/core/src/agent/tools/skill-management/file-port.js')
  const { createDesktopAgentSkillMutationAdapter } = await import('../src/main/agent/runtime/skill-storage.js')
  const database = join(directory, 'core.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    await mkdir(join(directory, ownerId))
    const service = desktopFiles(join(directory, ownerId), native)
    let failSync = true
    const adapter = createDesktopAgentSkillMutationAdapter({ core: runtime, dataRoot: directory,
      async hostRequest(method, params, signal) {
        if (method === 'agent.files.acquireSkillLock') return service.acquireAgentSkillLock(params.operationId, signal!)
        if (method === 'agent.files.releaseSkillLock') return service.releaseAgentSkillLock(params.operationId)
        if (method === 'agent.files.recordSkillHistory') {
          if (failSync) { failSync = false; throw new Error('合成历史同步失败') }
          return service.agentRecordSkillHistory(params)
        }
        throw new Error('未预期的宿主请求')
      } })
    const port = createDurableFileSkillManagementPort({ core: runtime, adapter, async authorize() { return true } })
    const identity = { ownerId, sessionId: '1', runId: 'run' }
    const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.execute>[2]
    const input = { skill_name: '示例', description_short: '描述', body: '正文', related_tools: [], managed_by: 'assistant' as const }
    const call = { id: 'create', name: 'create_skill', input }
    const result = await port.execute('create', input, scope, call)
    expect(result).toEqual({ kind: 'unknown' })
    const replay = await port.execute('create', input, scope, call)
    expect(replay).toMatchObject({ kind: 'completed', successful: true, mutated: false })
    if (replay.kind !== 'completed') throw new Error('技能创建失败')
    const slug = (replay.value as { skill: { id: string } }).skill.id
    const target = join(directory, ownerId, '.agent', 'skills', slug, 'SKILL.md')
    expect(await readFile(target, 'utf8')).toContain('正文')
    expect(await port.execute('create', input, scope, call)).toMatchObject({ mutated: false })
    const history = service.handlers[DESKTOP_CHANNELS.files]!
    expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await history({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
    expect(await readFile(target, 'utf8')).toContain('正文')
  } finally { await runtime.close() }
})

it('桌面 Agent 删除技能同步文件历史，撤销重做保留附属文件', async () => {
  const { initializeSqlite, openSqliteRuntime } = await import('../../../packages/core/src/data/sqlite.js')
  const { createDurableFileSkillDeletePort } = await import('../../../packages/core/src/agent/tools/skill-management/file-delete-port.js')
  const { readFileSkillDeleteTarget } = await import('../../../packages/core/src/agent/tools/skill-management/file-delete-target.js')
  const { createDesktopAgentSkillDeleteStorage } = await import('../src/main/agent/runtime/skill-storage.js')
  const database = join(directory, 'core.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    await mkdir(join(directory, ownerId))
    const service = desktopFiles(join(directory, ownerId), native)
    const bundle = await createUserSkillBundle(directory, ownerId, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
    await writeFile(join(bundle.path, 'reference.txt'), '附属资料')
    let failSync = true
    const storage = createDesktopAgentSkillDeleteStorage({ core: runtime, dataRoot: directory, async hostRequest(method, params, signal) {
      if (method === 'agent.files.acquireSkillLock') return service.acquireAgentSkillLock(params.operationId, signal!)
      if (method === 'agent.files.releaseSkillLock') return service.releaseAgentSkillLock(params.operationId)
      if (method === 'agent.files.recordSkillHistory') {
        if (failSync) { failSync = false; throw new Error('合成历史同步失败') }
        return service.agentRecordSkillHistory(params)
      }
      throw new Error('未预期的宿主请求')
    } })
    const confirmation = { async claim() { return true } } as unknown as Parameters<typeof createDurableFileSkillDeletePort>[0]['confirmation']
    const port = createDurableFileSkillDeletePort({ core: runtime, dataRoot: directory, storage, confirmation, async authorize() { return true } })
    const identity = { ownerId, sessionId: '1', runId: 'run' }, scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.remove>[0]['scope']
    const call = { id: 'delete', name: 'delete_skill', input: { id: 'demo' } }
    const target = await readFileSkillDeleteTarget(directory, ownerId, 'demo')
    expect(await port.remove({ target, scope, call, claim: {} as never })).toEqual({ kind: 'unknown' })
    expect(await port.reconcile({ id: 'demo', identity: { ...identity, roundId: 'round' }, call })).toMatchObject({ kind: 'completed', successful: true, mutated: false })
    const history = service.handlers[DESKTOP_CHANNELS.files]!
    expect(await history({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
    expect(await readFile(join(bundle.path, 'reference.txt'), 'utf8')).toBe('附属资料')
    await writeFile(join(bundle.path, 'reference.txt'), '用户修改')
    await expect(history({ action: 'redo-trash', directoryId: 'skill-packages' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(bundle.path, 'reference.txt'), 'utf8')).toBe('用户修改')
    await writeFile(join(bundle.path, 'reference.txt'), '附属资料')
    expect(await history({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
    await expect(readFile(join(bundle.path, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await runtime.close() }
})

it('Agent 技能锁与桌面文件修改串行，取消排队不会留下死锁', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  const bundle = await createUserSkillBundle(directory, owner, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
  const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002'
  await service.acquireAgentSkillLock(first, new AbortController().signal)
  let completed = false
  const update = service.updateSkillDocument('demo', bundle.contentDigest, { enabled: false }).then(value => { completed = true; return value })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(completed).toBe(false)
  service.releaseAgentSkillLock(first)
  await update
  expect(completed).toBe(true)
  await service.acquireAgentSkillLock(first, new AbortController().signal)
  const abort = new AbortController()
  const waiting = service.acquireAgentSkillLock(second, abort.signal)
  abort.abort()
  service.releaseAgentSkillLock(first)
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  await service.acquireAgentSkillLock(second, new AbortController().signal)
  service.releaseAllAgentSkillLocks()
})

it('桌面文件技能修改支持撤销重做并拒绝覆盖外部修改', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  const source = '---\nname: 示例\ndescription: 描述\nmetadata:\n  upstream: 保留\n---\n正文'
  await stageSkillPackage({ dataRoot: directory, ownerId: owner, slug: 'demo',
    files: new Map([['SKILL.md', bytes(source)], ['assets/a.txt', bytes('资源')]]),
    signal: new AbortController().signal, commit: input => service.installSkillPackage(input.stagedDirectory, input.slug) })
  const target = join(directory, owner, '.agent', 'skills', 'demo')
  const digest = (await listUserSkillBundles(directory, owner)).skills[0]!.content_digest
  await service.updateSkillDocument('demo', digest, { enabled: false })
  expect((await listUserSkillBundles(directory, owner)).skills[0]?.enabled).toBe(false)
  const execute = service.handlers[DESKTOP_CHANNELS.files]!
  expect(await execute({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(source)
  expect(await execute({ action: 'redo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect((await listUserSkillBundles(directory, owner)).skills[0]?.enabled).toBe(false)
  await writeFile(join(target, 'SKILL.md'), `${source}\n外部变更`)
  await expect(execute({ action: 'undo-trash', directoryId: 'skill-packages' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(service.updateSkillDocument('demo', digest, { enabled: true })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(join(target, 'assets/a.txt'), 'utf8')).toBe('资源')
})

it('删除文件技能后撤销恢复整个目录，重做不覆盖后续修改', async () => {
  const owner = '00000000-0000-4000-8000-000000000001'
  const service = desktopFiles(join(directory, owner), native)
  await stageSkillPackage({ dataRoot: directory, ownerId: owner, slug: 'demo',
    files: new Map([['SKILL.md', bytes('---\nname: 示例\ndescription: 描述\n---\n正文')], ['assets/a.txt', bytes('资源')]]),
    signal: new AbortController().signal, commit: input => service.installSkillPackage(input.stagedDirectory, input.slug) })
  const target = join(directory, owner, '.agent', 'skills', 'demo')
  const digest = (await listUserSkillBundles(directory, owner)).skills[0]!.content_digest
  await expect(service.deleteSkillPackage('demo', 'f'.repeat(64))).rejects.toMatchObject({ code: 'conflict' })
  await service.deleteSkillPackage('demo', digest)
  await expect(readFile(join(target, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  const execute = service.handlers[DESKTOP_CHANNELS.files]!
  expect(await execute({ action: 'undo-trash', directoryId: 'skill-packages' })).toEqual({ changed: true })
  expect(await readFile(join(target, 'assets/a.txt'), 'utf8')).toBe('资源')
  await writeFile(join(target, 'assets/a.txt'), '后续修改')
  await expect(execute({ action: 'redo-trash', directoryId: 'skill-packages' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(join(target, 'assets/a.txt'), 'utf8')).toBe('后续修改')
})

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'gugu-files-')))
  await mkdir(join(directory, 'app'))
  picked = undefined
  trashFailure = false
  trashed = []
  files = createFiles()
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

it('文件夹引用可以搜索和打开，目录被同名替换后失效', async () => {
  const root = await files.personalRoot()
  await mkdir(join(root, '参考目录'))
  const target = { directoryId: 'personal', path: '参考目录' }
  const reference = await call({ action: 'reference', kind: 'folder', ...target }) as { type: string; id: string }
  expect(reference).toMatchObject({ type: 'folder', label: '参考目录' })
  expect(await call({ action: 'search', query: '参考目录' })).toEqual(expect.arrayContaining([expect.objectContaining(reference)]))
  const resolved = await files.resolveWorkspaceReference(reference.id)
  expect(resolved).toMatchObject({ type: 'folder', path: join(root, target.path) })
  const verified = { action: 'reference', kind: 'folder', ...target, identity: resolved?.fileIdentity }
  await expect(call(verified)).resolves.toEqual(reference)
  await rename(join(root, target.path), join(root, '原目录'))
  await mkdir(join(root, target.path))
  expect(await files.resolveWorkspaceReference(reference.id)).toBeNull()
  await expect(call(verified)).rejects.toMatchObject({ code: 'not_found' })
})

async function selectionCommand(path: string) {
  const target = { directoryId: 'personal', path }
  const entries = await call({ action: 'list', directoryId: target.directoryId, path: '' }) as Array<{ relativePath: string; revision: string }>
  const reference = await call({ action: 'reference', ...target }) as { id: string }
  const resolved = await files.resolveWorkspaceReference(reference.id)
  expect(resolved?.fileIdentity).toBeTruthy()
  return {
    action: 'replace-selection', ...target, identity: resolved?.fileIdentity,
    revision: entries.find(entry => entry.relativePath === path)?.revision,
    expected: '原文', replacement: '改文',
  }
}

it('文件选区只接受一次并发替换，后续请求不能覆盖结果', async () => {
  const file = join(await files.personalRoot(), '样本.txt')
  await writeFile(file, '前缀原文后缀')
  const command = await selectionCommand('样本.txt')
  const results = await Promise.allSettled([call(command), call({ ...command, replacement: '另一处' })])
  expect(results[0]).toEqual({ status: 'fulfilled', value: { changed: true } })
  expect(results[1]).toMatchObject({ status: 'rejected' })
  expect(await readFile(file, 'utf8')).toBe('前缀改文后缀')
})

it('文件选区拒绝重复原文、跨工作区、改名替换和删除', async () => {
  const root = await files.personalRoot()
  const file = join(root, '样本.txt')
  await writeFile(file, '原文原文')
  const command = await selectionCommand('样本.txt')
  await expect(call(command)).rejects.toMatchObject({ code: 'conflict' })
  await expect(call({ ...command, directoryId: '未授权工作区' })).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('原文原文')

  const renamed = join(root, '已改名.txt')
  await rename(file, renamed)
  await writeFile(file, '原文')
  await expect(call(command)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('原文')
  expect(await readFile(renamed, 'utf8')).toBe('原文原文')
  await rm(file)
  await expect(call(command)).rejects.toThrow()
  await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('拖出解析已选工作区的文件和目录，拒绝链接和越界路径', async () => {
  const root = await files.personalRoot()
  const file = join(root, '合成.txt')
  await writeFile(file, '合成内容')
  await mkdir(join(root, '资料'))
  await expect(files.resolveFileForDrag('personal', '合成.txt')).resolves.toBe(file)
  await expect(files.resolveFileForDrag('personal', '资料')).resolves.toBe(join(root, '资料'))
  await expect(files.resolveFileForDrag('personal', '../合成.txt')).rejects.toMatchObject({ code: 'invalid_request' })
  if (process.platform !== 'win32') {
    const external = join(directory, '外部.txt')
    await writeFile(external, '工作区之外')
    await symlink(external, join(root, '链接.txt'))
    await expect(files.resolveFileForDrag('personal', '链接.txt')).rejects.toMatchObject({ code: 'forbidden' })
  }
})

it('工具搜索支持 AND、本机绝对路径和工作区边界', async () => {
  const root = await files.personalRoot()
  await mkdir(join(root, '样本目录'))
  await writeFile(join(root, '样本目录', '会议.txt'), '合成内容')
  await writeFile(join(root, '会议.txt'), '另一份')
  await writeFile(join(directory, '样本会议.txt'), '库外')
  const found = await files.globalFileSearch(['样本', '会议'], 'AND', 20)
  expect(found.groups).toMatchObject([{ type: 'file', items: [
    { title: '会议.txt', path_file: { directoryId: 'personal', location: { kind: 'host_absolute', value: join(root, '样本目录/会议.txt') } } },
  ] }])
  const exact = await files.globalFileSearch([join(root, '样本目录/会议.txt')])
  expect(exact.groups[0]?.items).toHaveLength(1)
  expect(exact.groups[0]?.items[0]?.path_file.relativePath).toBe('样本目录/会议.txt')
})

it('保存已授权聊天附件时原子写入、保留同名文件并恢复重复调用', async () => {
  const sourceRoot = join(directory, 'app', 'agent-attachments')
  await mkdir(sourceRoot)
  const source = bytes('附件正文')
  const attachId = 'b'.repeat(32)
  await writeFile(join(sourceRoot, attachId), source)
  const operationId = 'a'.repeat(64)
  const fingerprint = 'c'.repeat(64)
  const params = {
    operationId, fingerprint, attachId, expectedSize: source.byteLength,
    expectedDigest: createHash('sha256').update(source).digest('hex'), name: '资料.txt', space: 'personal',
  }
  const concurrent = await Promise.all([
    files.agentSaveAttachment(params, AbortSignal.timeout(5_000)) as Promise<Record<string, unknown>>,
    files.agentSaveAttachment(params, AbortSignal.timeout(5_000)) as Promise<Record<string, unknown>>,
  ])
  expect(concurrent).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: '资料.txt', size_bytes: source.byteLength, replayed: false }),
    expect.objectContaining({ name: '资料.txt', size_bytes: source.byteLength, replayed: true }),
  ]))
  const root = await files.personalRoot()
  expect(await readFile(join(root, 'download', '资料.txt'), 'utf8')).toBe('附件正文')
  await expect(readFile(join(root, '资料.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  const first = concurrent.find(result => result.replayed === false)!
  const replay = await files.agentSaveAttachment(params, AbortSignal.timeout(5_000))
  expect(replay).toMatchObject({ ...first, replayed: true })
  await expect(readFile(join(root, 'download', '资料 (2).txt'))).rejects.toMatchObject({ code: 'ENOENT' })

  await writeFile(join(root, 'download', '同名.txt'), '已有内容')
  const second = await files.agentSaveAttachment({ ...params, operationId: 'd'.repeat(64), name: '同名.txt' }, AbortSignal.timeout(5_000))
  expect(second).toMatchObject({ name: '同名 (2).txt', replayed: false })
  expect(await readFile(join(root, 'download', '同名.txt'), 'utf8')).toBe('已有内容')
  expect(await readFile(join(root, 'download', '同名 (2).txt'), 'utf8')).toBe('附件正文')

  await mkdir(join(root, '资料'))
  const nested = await files.agentSaveAttachment({ ...params, operationId: 'f'.repeat(64), name: '子目录.txt', folderPath: '资料' }, AbortSignal.timeout(5_000))
  expect(nested).toMatchObject({ name: '子目录.txt', path: '资料/子目录.txt', replayed: false })
  expect(await readFile(join(root, '资料', '子目录.txt'), 'utf8')).toBe('附件正文')

  await expect(files.agentSaveAttachment({ ...params, fingerprint: 'e'.repeat(64) }, AbortSignal.timeout(5_000)))
    .rejects.toMatchObject({ code: 'conflict' })
})

it('附件保存到当前会话指定的本机工作区目录并拒绝未登记目录', async () => {
  const sourceRoot = join(directory, 'app', 'agent-attachments')
  const workspaceRoot = join(directory, 'external-workspace')
  await mkdir(sourceRoot)
  await mkdir(workspaceRoot)
  picked = workspaceRoot
  const workspace = await call({ action: 'workspace-add' }) as { id: string }
  const source = bytes('工作区附件')
  const attachId = 'c'.repeat(32)
  await writeFile(join(sourceRoot, attachId), source)
  const params = {
    operationId: '1'.repeat(64), fingerprint: '2'.repeat(64), attachId,
    expectedSize: source.byteLength, expectedDigest: createHash('sha256').update(source).digest('hex'),
    name: '工作区资料.txt', space: 'workspace', workspaceDirectoryId: workspace.id,
  }

  await expect(files.agentSaveAttachment(params, AbortSignal.timeout(5_000))).resolves.toMatchObject({
    name: '工作区资料.txt', path: '工作区资料.txt', space: 'workspace', replayed: false,
  })
  await expect(readFile(join(workspaceRoot, '工作区资料.txt'), 'utf8')).resolves.toBe('工作区附件')
  await expect(files.agentSaveAttachment({ ...params, operationId: '3'.repeat(64), workspaceDirectoryId:
    'desktop:22222222-2222-4222-8222-222222222222' }, AbortSignal.timeout(5_000)))
    .rejects.toMatchObject({ code: 'not_found' })
})

it('工作区引用解析原文件的绝对路径，原件移动后拒绝同名替代文件', async () => {
  const root = await files.personalRoot()
  const relativePath = '合成资料.md'
  const path = join(root, relativePath)
  await writeFile(path, '原件')
  const reference = await call({ action: 'reference', directoryId: 'personal', path: relativePath }) as { id: string; type: 'file'; label: string }
  const db = {} as Parameters<typeof resolveDesktopChatReferences>[0]
  const render = () => resolveDesktopChatReferences(db, '3b806375-5a04-467a-b4e8-353f6af5d345', [reference], '阅读资料', async id => {
    const file = await files.resolveWorkspaceReference(id)
    if (!file) return null
    const excerpt = await readDroppedFileExcerpt(file.path, file.fileIdentity)
    return excerpt ? { ...file, ...excerpt } : null
  })
  const context = await render()
  expect(context).toContain(`【路径】${JSON.stringify(path)}`)
  expect(context).toContain('【路径类型】"host_absolute"')
  expect(context).toContain(`【父目录】${JSON.stringify(root)}`)
  expect(context).toContain(`【相对路径】${JSON.stringify(relativePath)}`)
  await rename(path, join(root, '改名.md'))
  await writeFile(path, '替代文件')
  const stale = await render()
  expect(stale).toContain('引用已失效')
  expect(stale).not.toContain(path)
  expect(stale).not.toContain('替代文件')
})

it('展示文件支持唯一文件名和本轮绝对引用，同名时要求准确路径', async () => {
  const root = await files.personalRoot()
  const folder = join(root, '资料')
  const path = join(folder, '合成.jpg')
  await mkdir(folder)
  await writeFile(path, '合成图片')
  const reference = await call({ action: 'reference', directoryId: 'personal', path: '资料/合成.jpg' }) as { id: string }
  const match = { preview: { workspaceFile: { directoryId: 'personal', relativePath: '资料/合成.jpg' }, ext: 'jpg' } }
  await expect(files.resolvePresentation('合成.jpg')).resolves.toMatchObject(match)
  await expect(files.resolvePresentation(path, reference.id)).resolves.toMatchObject(match)
  await expect(files.resolvePresentation(path)).resolves.toHaveProperty('error')
  await writeFile(join(root, '合成.jpg'), '另一份合成图片')
  await expect(files.resolvePresentation('合成.jpg')).resolves.toMatchObject({ error: expect.stringContaining('同名') })
  await expect(files.resolvePresentation('/personal/资料/合成.jpg')).resolves.toMatchObject(match)
})

it('图片按用户偏好选择预览或系统打开，不支持预览的文件交给系统', () => {
  expect(shouldOpenFileInSystem('preview', 'jpg', 'image/jpeg')).toBe(false)
  expect(shouldOpenFileInSystem('system', 'jpg', 'image/jpeg')).toBe(true)
  expect(shouldOpenFileInSystem('preview', 'zip')).toBe(true)
})

it('授权后的本机绝对路径可打开库内文件，并以只读内容流展示库外原件', async () => {
  const root = await files.personalRoot()
  const library = join(root, '合成.md')
  const external = join(directory, '库外资料.md')
  await writeFile(library, '合成文件')
  await writeFile(external, '外部原件')
  const identity = async (path: string) => {
    const { dev, ino, birthtimeNs } = await lstat(path, { bigint: true })
    return [dev, ino, birthtimeNs].join('.')
  }
  const externalId = await identity(external)
  await expect(files.resolveHostPresentation(library, await identity(library))).resolves.toMatchObject({
    workspaceFile: { directoryId: 'personal', relativePath: '合成.md' },
  })
  await expect(files.resolveHostPresentation(external, externalId)).resolves.toBeUndefined()
  expect(await (await files.hostPresentationContent(external, externalId, null)).text()).toBe('外部原件')
  const metadata = await files.hostPresentationContent(external, externalId, null, 'metadata')
  expect(await metadata.json()).toEqual({ name: '库外资料.md', size: Buffer.byteLength('外部原件') })
  expect((await files.hostPresentationContent(external, externalId, null, 'thumbnail')).status).toBe(404)
  await rename(external, join(directory, '移走的原件.md'))
  await writeFile(external, '新文件')
  await expect(files.resolveHostPresentation(external, externalId)).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.hostPresentationContent(external, externalId, null)).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.hostPresentationContent(external, externalId, null, 'metadata')).rejects.toMatchObject({ code: 'not_found' })
})

it.skipIf(!['darwin', 'win32'].includes(process.platform))('宿主文件与 Shell 共用会话授权，自动模式可直接通过', () => {
  const identity = { ownerId: 'owner-synthetic', sessionId: 'present-synthetic', runId: 'run-synthetic' }
  const access = { shellEnabled: true, dangerousEnabled: true, automaticMode: false }
  const grant = desktopHostAuthorization(access, identity, JSON.stringify)
  expect(grant?.permits()).toBe(false)
  grant?.approve()
  expect(desktopHostAuthorization(access, { ...identity, runId: 'new-run' }, JSON.stringify)?.permits()).toBe(true)
  const newSession = { ...identity, sessionId: 'another-session' }
  expect(desktopHostAuthorization(access, newSession, JSON.stringify)?.permits()).toBe(false)
  expect(desktopHostAuthorization({ ...access, automaticMode: true }, newSession, JSON.stringify)?.permits()).toBe(true)
  expect(desktopHostAuthorization({ ...access, automaticMode: true, shellEnabled: false }, newSession, JSON.stringify)).toBeNull()
})

it('打开方式作为桌面偏好持久化，拒绝未知值并保留其他设置', async () => {
  let document: Record<string, unknown> = { useSystemProxy: true }
  const store = {
    async read() { return document },
    async write(_owner: string, value: Record<string, unknown>) { document = value },
  }
  const owner = '3b806375-5a04-467a-b4e8-353f6af5d345'
  const settings = createDesktopAppearanceService(store)
  await settings.update(owner, { fileOpenPreference: 'system' })
  await expect(createDesktopAppearanceService(store).get(owner)).resolves.toMatchObject({
    fileOpenPreference: 'system', useSystemProxy: true,
  })
  await expect(settings.update(owner, { fileOpenPreference: 'unknown' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(settings.update(owner, { fileOpenPreference: 'preview' })).resolves.toMatchObject({ fileOpenPreference: 'preview' })
})

it('Agent 下载只提交到绑定的个人下载目录，拒绝覆盖和失效目录', async () => {
  const dataRoot = join(directory, 'app')
  const staged = await mkdtemp(join(dataRoot, '.gugu-download-'))
  const body = join(staged, 'body')
  await writeFile(body, '合成下载内容')
  const target = await files.agentDownloadTarget()
  const personal = await files.personalRoot()
  const params = { stage: basename(staged), filename: '合成下载.txt', target }
  const signal = new AbortController().signal
  await files.agentCommitDownload(dataRoot, params, signal)
  const saved = join(personal, 'download', params.filename)
  expect(await readFile(saved, 'utf8')).toBe('合成下载内容')
  await writeFile(body, '不应覆盖')
  await expect(files.agentCommitDownload(dataRoot, params, signal)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(saved, 'utf8')).toBe('合成下载内容')
  const folderPath = '素材'
  const customDirectory = join(personal, folderPath)
  await mkdir(customDirectory)
  const custom = { ...params, folderPath, target: await files.agentDownloadTarget(folderPath) }
  await files.agentCommitDownload(dataRoot, custom, signal)
  expect(await readFile(join(customDirectory, params.filename), 'utf8')).toBe('不应覆盖')
  await rename(customDirectory, join(personal, '素材备份'))
  await mkdir(customDirectory)
  await expect(files.agentCommitDownload(dataRoot, custom, signal)).rejects.toMatchObject({ code: 'conflict' })
  await rename(personal, join(directory, '原个人目录'))
  await mkdir(personal)
  await expect(files.agentCommitDownload(dataRoot, params, signal)).rejects.toMatchObject({ code: 'conflict' })
  await expect(readFile(saved)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('并行读取缩略图复用生成结果，文件更新或移除后重新校验', async () => {
  let generated = 0
  files = desktopFiles(join(directory, 'Gugu-data'), {
    ...native,
    async thumbnail(content) {
      generated += 1
      return content
    },
  })
  const path = join(await files.personalRoot(), '封面.png')
  await writeFile(path, '原图')
  const url = new URL('https://example.com/content')
  url.search = new URLSearchParams({ path: '封面.png', thumbnail: '1' }).toString()
  const read = () => files.content(url, null)

  const responses = await Promise.all([read(), read(), read()])
  expect(await Promise.all(responses.map(response => response.text()))).toEqual(['原图', '原图', '原图'])
  expect(responses[0]?.headers.get('Cache-Control')).toBe('no-store')
  expect(await (await read()).text()).toBe('原图')
  expect(generated).toBe(1)

  await writeFile(path, '更新后的图')
  expect(await (await read()).text()).toBe('更新后的图')
  expect(generated).toBe(2)

  await rm(path)
  await expect(read()).rejects.toMatchObject({ code: 'ENOENT' })
  expect(generated).toBe(2)
})

it('上传、查找和引用文件，删除交给系统回收站', async () => {
  const path = '资料/读书.md'
  await call({ action: 'mkdir', path: '资料' })
  await call({ action: 'upload', path, data: bytes('读书笔记') })
  await expect(call({ action: 'upload', path, data: bytes('覆盖') })).rejects.toMatchObject({ code: 'conflict' })
  const [hint] = await call({ action: 'search', query: '读书' }) as { id: string; label: string }[]
  expect(hint.label).toBe('读书.md')
  const ref = JSON.parse(Buffer.from(hint.id.slice(5), 'base64url').toString())
  const url = new URL('https://example.com/content')
  url.search = new URLSearchParams({ path, identity: ref.identity }).toString()
  const response = await files.content(url, null)
  expect(await response.text()).toBe('读书笔记')
  expect(ref.directoryId).toBe('personal')
  const legacy = join(directory, 'Gugu-data', '.gugu-trash')
  await mkdir(legacy)
  await writeFile(join(legacy, '历史数据'), '历史文件')
  trashFailure = true
  await expect(call({ action: 'trash', path })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(join(directory, 'Gugu-data', 'personal', path), 'utf8')).toBe('读书笔记')
  trashFailure = false
  await call({ action: 'trash', path })
  expect(trashed).toEqual([join(directory, 'Gugu-data', 'personal', path), join(directory, 'Gugu-data', 'personal', path)])
  expect(await readFile(join(directory, '系统回收站测试项-2'), 'utf8')).toBe('读书笔记')
  expect(await readFile(join(legacy, '历史数据'), 'utf8')).toBe('历史文件')
  await call({ action: 'mkdir', path: '资料/子目录' })
  await call({ action: 'upload', path: '资料/子目录/说明.md', data: bytes('不计入上级') })
  await expect(call({ action: 'list', path: '' })).resolves.toEqual([
    expect.objectContaining({ name: '资料', fileCount: 0, folderCount: 1 }),
  ])
})

it('Agent 文件概览递归统计个人文件并截断最近文件清单', async () => {
  await call({ action: 'mkdir', path: '资料' })
  await call({ action: 'mkdir', path: '资料/子目录' })
  await call({ action: 'upload', path: '根文件.md', data: bytes('根内容') })
  await call({ action: 'upload', path: '资料/旧文件.txt', data: bytes('旧内容') })
  await call({ action: 'upload', path: '资料/子目录/新文件.md', data: bytes('新内容') })

  const overview = await files.agentOverview()
  expect(overview.total).toBe(3)
  expect(overview).not.toHaveProperty('trash')
  expect(overview.partial).toBe(false)
  expect(overview.folders).toEqual([{ name: '资料', path: '资料', file_count: 2 }])
  expect(overview.files).toEqual(expect.arrayContaining([
    { name: '根文件.md', folder: null, space: 'personal' },
    { name: '旧文件.txt', folder: '资料', space: 'personal' },
    { name: '新文件.md', folder: '资料/子目录', space: 'personal' },
  ]))
})

it('Agent 逻辑路径只解析个人授权目录并拒绝路径穿越与链接', async () => {
  await call({ action: 'mkdir', path: '资料' })
  await call({ action: 'upload', path: '资料/说明.txt', data: bytes('合成文件内容') })
  await expect(files.agentResolveFile('/personal/资料/说明.txt')).resolves.toEqual(expect.objectContaining({
    name: '说明.txt', relativePath: '资料/说明.txt', text: true, extension: 'txt',
    previewFile: expect.objectContaining({
      workspaceFile: { directoryId: 'personal', relativePath: '资料/说明.txt', identity: expect.any(String) },
      displayName: '说明.txt', ext: 'txt', mimeType: 'text/plain', sizeBytes: Buffer.byteLength('合成文件内容'),
    }),
  }))
  const signal = new AbortController().signal
  const outbound = await files.agentReadSendFile('/personal/资料/说明.txt', signal)
  expect(outbound).toMatchObject({ name: '说明', ext: 'txt', mime: 'text/plain', data: Buffer.from('合成文件内容') })
  expect(await outbound?.authorize()).toBe(true)
  expect(await files.agentReadSendFile('/personal/资料/说明.txt', signal, 2)).toBeNull()
  expect(await files.agentReadSendFile('/personal/../外部.txt', signal)).toBeNull()
  expect(await files.agentResolveFile('/personal/../外部.txt')).toBeNull()
  expect(await files.agentResolveFile('/Users/private/机密.txt')).toBeNull()

  const outside = join(directory, '外部.txt')
  await writeFile(outside, '不应读取')
  await symlink(outside, join(directory, 'Gugu-data', 'personal', '链接.txt'))
  await expect(files.agentReadSendFile('/personal/链接.txt', signal)).rejects.toMatchObject({ code: 'forbidden' })
  await rm(join(directory, 'Gugu-data', 'personal', '资料', '说明.txt'))
  expect(await outbound?.authorize()).toBe(false)
})

it('Agent 逻辑路径解析已绑定工作区和 owner 项目目录', async () => {
  const workspace = join(directory, '外部工作区')
  await mkdir(workspace)
  picked = workspace
  expect(await call({ action: 'workspace-add' })).toEqual({ id: expect.stringMatching(/^desktop:/u) })
  await writeFile(join(workspace, '工作区说明.md'), '工作区正文')
  await expect(files.agentResolveFile('/workspace/外部工作区/工作区说明.md')).resolves.toEqual(expect.objectContaining({
    name: '工作区说明.md', relativePath: '工作区说明.md', text: true, extension: 'md',
  }))

  const root = join(directory, 'Gugu-data')
  files = desktopFiles(root, native, join(directory, 'app', 'workspaces.json'), join(directory, 'app'), async id => {
    if (id !== 12) throw Object.assign(new Error('not found'), { code: 'not_found' })
    return { name: '小北项目', startDate: '2026-11-20', createdAt: '2026-11-20', deletedAt: null }
  })
  await call({ action: 'upload', directoryId: 'project:12', path: '项目说明.txt', data: bytes('项目正文') })
  await expect(files.agentResolveFile('/project/2026/11/小北项目 #12/项目说明.txt')).resolves.toEqual(expect.objectContaining({
    name: '项目说明.txt', relativePath: '项目说明.txt', text: true, extension: 'txt',
  }))
  await call({ action: 'mkdir', directoryId: 'project:12', path: '资料' })
  await call({ action: 'upload', directoryId: 'project:12', path: '资料/嵌套.txt', data: bytes('嵌套文件') })
  await expect(files.agentProjectFileOverview(12, new AbortController().signal)).resolves.toMatchObject({
    total_file_count: 2, root_file_count: 1, total_folder_count: 1,
  })
  expect(await files.agentResolveFile('/project/小北项目 #99/项目说明.txt')).toBeNull()
  const hit = (await files.globalFileSearch(['小北项目'])).groups.find(group => group.type === 'folder')?.items[0]
  expect(hit).toMatchObject({ title: '小北项目', path_file: { directoryId: 'project:12', relativePath: '' } })
  const id = hit && 'link' in hit ? hit.link?.split('/').at(-1) : undefined
  expect(id).toBeTruthy()
  await expect(files.resolveWorkspaceReference(id!)).resolves.toMatchObject({ type: 'folder', directoryId: 'project:12', relativePath: '' })

})

it('关联工作区会切换当前目录，切回或解除关联后保留共享文件', async () => {
  const workspace = join(directory, '共享目录')
  await mkdir(workspace)
  await writeFile(join(workspace, '样本.txt'), '样本内容')
  picked = workspace
  const root = join(directory, 'Gugu-data')
  const registry = join(directory, 'app', 'workspaces.json')
  const readProject = async () => ({ name: '样本项目', startDate: '2026-11-20', createdAt: '2026-11-20', deletedAt: null })
  files = desktopFiles(root, native, registry, undefined, readProject)
  const { id: directoryId } = await call({ action: 'workspace-add' }) as { id: string }
  await Promise.all([12, 13].map(projectId => call({ action: 'project-workspace-binding', projectId, directoryId, bound: true })))
  files = desktopFiles(root, native, registry, undefined, readProject)
  const summary = [{ id: directoryId, name: '共享目录', available: true, location: { kind: 'host_absolute', value: await realpath(workspace) } }]
  const overview = (id: number) => files.agentProjectFileOverview(id, new AbortController().signal)
  await expect(overview(12)).resolves.toMatchObject({ workspaces: summary })
  await expect(call({ action: 'project-workspaces', projectId: 12 })).resolves.toMatchObject([{ id: directoryId, active: true }])
  await expect(call({ action: 'project-workspaces', projectId: 13 })).resolves.toMatchObject([{ id: directoryId, active: true }])
  await expect(overview(12)).resolves.toMatchObject({ total_file_count: 1, location: summary[0]!.location })
  await expect(files.agentProjectFilePath(12)).resolves.toBe(summary[0]!.location.value)
  await call({ action: 'project-workspace-binding', projectId: 12, directoryId: 'project:12', bound: true })
  await expect(overview(12)).resolves.toMatchObject({ total_file_count: 0, workspaces: summary })
  await expect(call({ action: 'project-workspace-binding', projectId: 12, directoryId, bound: true })).resolves.toMatchObject({ changed: true })
  await expect(call({ action: 'project-workspace-binding', projectId: 12, directoryId, bound: true })).resolves.toMatchObject({ changed: false })
  const hits = (await files.globalFileSearch(['样本项目'])).groups.find(group => group.type === 'folder')?.items
  expect(hits).toHaveLength(1)
  expect(hits?.[0]).toMatchObject({ title: '样本项目', path_file: { directoryId, relativePath: '', location: summary[0]!.location } })

  await expect(files.isWorkspaceBoundToProject(99, directoryId)).resolves.toBe(false)

  let allowed = false
  const toolRegistry = createToolRegistry({
    authorize: async () => allowed,
    tools: [createProjectWorkspaceBindingTool(async (_identity, input) => {
      const result = await call({ action: 'project-workspace-binding', projectId: input.project_id,
        directoryId: input.workspace_id, bound: input.bound }) as { changed: boolean }
      return result.changed
    })],
  })
  const dispatch = (id: string, bound: boolean, workspaceId = directoryId) => toolRegistry.tools.dispatch({
    id, name: 'set_project_workspace', input: { project_id: 12, workspace_id: workspaceId, bound },
  }, {
    identity: { ownerId: '48b87fdd-16a7-4934-8d1d-ed1ef33e9ac8', sessionId: '1', runId: '1' },
    roundId: '1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不应调用执行后端') },
  })
  await expect(dispatch('denied', false)).resolves.toMatchObject({ kind: 'completed', successful: false })
  await expect(files.isWorkspaceBoundToProject(12, directoryId)).resolves.toBe(true)
  allowed = true
  await expect(dispatch('unlink', false)).resolves.toMatchObject({ kind: 'completed', successful: true, mutated: true })
  await expect(dispatch('repeat', false)).resolves.toMatchObject({ kind: 'completed', successful: true, mutated: false })
  await expect(files.isWorkspaceBoundToProject(12, directoryId)).resolves.toBe(false)
  await expect(overview(12)).resolves.not.toHaveProperty('workspaces')
  await expect(files.agentProjectFilePath(12)).resolves.not.toBe(summary[0]!.location.value)
  await expect(overview(13)).resolves.toMatchObject({ workspaces: summary })
  const alternative = join(directory, '备用目录')
  await mkdir(alternative)
  picked = alternative
  const { id: alternativeId } = await call({ action: 'workspace-add' }) as { id: string }
  await expect(dispatch('bind-alternative', true, alternativeId)).resolves.toMatchObject({ successful: true, mutated: true })
  await expect(dispatch('bind-shared', true)).resolves.toMatchObject({ successful: true, mutated: true })
  await expect(dispatch('unlink-inactive', false, alternativeId)).resolves.toMatchObject({ successful: true, mutated: true })
  await expect(files.agentProjectFilePath(12)).resolves.toBe(summary[0]!.location.value)
  await expect(readFile(join(workspace, '样本.txt'), 'utf8')).resolves.toBe('样本内容')
})

it('系统默认应用只接收当前目录内已校验的文件', async () => {
  const opened: string[] = []
  files = desktopFiles(join(directory, 'Gugu-data'), {
    ...native,
    async open(path) { opened.push(path); return path.endsWith('.bin') ? '合成关联错误' : '' },
  })
  await call({ action: 'mkdir', path: '资料' })
  await call({ action: 'upload', path: '资料/样本.txt', data: bytes('测试') })
  await call({ action: 'upload', path: '资料/样本.bin', data: bytes('测试') })
  const target = join(directory, 'Gugu-data', 'personal', '资料')
  await symlink(join(target, '样本.txt'), join(target, '链接.txt'))
  await expect(call({ action: 'open', path: '资料/样本.txt' })).resolves.toEqual({ ok: true })
  await expect(call({ action: 'open', path: '资料/样本.txt', identity: '旧引用' })).rejects.toMatchObject({ code: 'not_found' })
  await expect(call({ action: 'open', path: '资料' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(call({ action: 'open', path: '../样本.txt' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(call({ action: 'open', path: '资料/链接.txt' })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'open', path: '资料/样本.bin' })).rejects.toMatchObject({ code: 'unsupported' })
  expect(opened).toEqual([join(target, '样本.txt'), join(target, '样本.bin')])
})

it('拒绝路径穿越、符号链接和把目录放进自身', async () => {
  const external = join(directory, '外部目录')
  await mkdir(external)
  await writeFile(join(external, '隔离文件.txt'), '隔离')
  await call({ action: 'mkdir', path: '内部' })
  await symlink(external, join(directory, 'Gugu-data', 'personal', '链接'), 'junction')
  await expect(call({ action: 'list', path: '../外部目录' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(call({ action: 'list', path: '链接' })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'upload', path: '链接/隔离文件.txt', data: bytes('覆盖'), overwrite: true }))
    .rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'copy', path: '内部', destination: '内部/副本' })).rejects.toMatchObject({ code: 'invalid_request' })
  expect(await readFile(join(external, '隔离文件.txt'), 'utf8')).toBe('隔离')
})


it('绑定和重新定位保留工作区 ID，解除绑定后保留文件且拒绝通过旧 ID 访问', async () => {
  await expect(call({ action: 'workspace-add' })).resolves.toEqual({ id: null })
  picked = join(directory, '客户资料')
  await mkdir(picked)
  const { id } = await call({ action: 'workspace-add' }) as { id: string }
  await expect(call({ action: 'workspace-add' })).resolves.toEqual({ id })
  await call({ action: 'workspace-rename', directoryId: id, name: '合同资料' })
  await call({ action: 'upload', directoryId: id, path: '同名.md', data: bytes('外部') })
  await call({ action: 'upload', path: '同名.md', data: bytes('个人') })

  files = createFiles()
  await expect(call({ action: 'workspace-list' })).resolves.toEqual([
    { id: 'personal', name: '个人文件' }, { id, name: '合同资料' },
  ])
  const [hint] = await call({ action: 'search', directoryId: id, query: '同名' }) as { id: string }[]
  await expect(call({ action: 'search', query: '同名' })).resolves.toHaveLength(2)
  const reference = JSON.parse(Buffer.from(hint.id.slice(5), 'base64url').toString())
  expect(reference.directoryId).toBe(id)
  const url = new URL('https://example.com/content')
  url.search = new URLSearchParams({ directoryId: id, path: '同名.md', identity: reference.identity }).toString()
  expect(await (await files.content(url, null)).text()).toBe('外部')

  const moved = join(directory, '已移动')
  await rename(picked, moved)
  await expect(call({ action: 'list', directoryId: id, path: '' })).rejects.toMatchObject({ code: 'workspace_unavailable' })
  picked = moved
  await expect(call({ action: 'workspace-relink', directoryId: id })).resolves.toEqual({ id })
  expect(await (await files.content(url, null)).text()).toBe('外部')
  await call({ action: 'workspace-remove', directoryId: id })
  await expect(files.content(url, null)).rejects.toMatchObject({ code: 'not_found' })
  expect(await readFile(join(moved, '同名.md'), 'utf8')).toBe('外部')
})

it('拒绝将应用数据目录绑定为工作区', async () => {
  picked = join(directory, 'app')
  await expect(call({ action: 'workspace-add' })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'workspace-remove', directoryId: 'personal' })).rejects.toMatchObject({ code: 'forbidden' })
})

it('项目按 Linux 目录规则落盘，改名及跨月后原文件和引用继续可读', async () => {
  const root = join(directory, 'Gugu-data')
  const id = 'project:12'
  const path = '图稿.md'
  let project = { name: '小北/设计', startDate: '2026-11-20', createdAt: '2026-10-01', deletedAt: null as string | null }
  const createProjectFiles = () => desktopFiles(root, native, undefined, undefined, async projectId => {
    if (projectId !== 12) throw new Error('意外项目 ID')
    return project
  })
  files = createProjectFiles()
  await expect(call({ action: 'list', directoryId: id, path: '' })).resolves.toEqual([])
  await expect(readFile(join(root, 'projects', '2026', '11', '小北_设计 #12', path))).rejects.toMatchObject({ code: 'ENOENT' })
  await call({ action: 'upload', directoryId: id, path, data: bytes('原文件') })
  const original = join(root, 'projects', '2026', '11', '小北_设计 #12', path)
  expect(await readFile(original, 'utf8')).toBe('原文件')
  await expect(files.resolveFileForDrag(id, path)).resolves.toBe(original)
  const hint = await call({ action: 'reference', directoryId: id, path }) as { id: string }
  const { directoryId, identity } = JSON.parse(Buffer.from(hint.id.slice(5), 'base64url').toString())
  await expect(call({ action: 'list', path: '' })).resolves.toEqual([])
  await expect(call({ action: 'search', query: '图稿' })).resolves.toEqual([
    expect.objectContaining({ id: hint.id, label: '图稿.md' }),
  ])
  expect(directoryId).toBe(id)

  project = { ...project, name: '交付', startDate: '2027-01-02' }
  files = createProjectFiles()
  const url = new URL('https://example.com/content')
  url.search = new URLSearchParams({ directoryId, path, identity }).toString()
  expect(await (await files.content(url, null)).text()).toBe('原文件')
  await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(root, 'projects', '2027', '01', '交付 #12', path), 'utf8')).toBe('原文件')

  project = { ...project, deletedAt: '2027-02-01' }
  await expect(call({ action: 'list', directoryId: id, path: '' })).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.content(url, null)).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.resolveFileForDrag(id, path)).rejects.toMatchObject({ code: 'not_found' })
})

it('项目目录解析拒绝链接年月目录与工作区外路径', async () => {
  const root = join(directory, 'Gugu-data')
  const outside = join(directory, '外部目录')
  await mkdir(join(root, 'projects'), { recursive: true })
  await mkdir(outside)
  await symlink(outside, join(root, 'projects', '2026'), 'junction')
  files = desktopFiles(root, native, undefined, undefined, async () => ({
    name: '小北', startDate: '2026-11-20', createdAt: '2026-10-01', deletedAt: null,
  }))
  await expect(call({ action: 'upload', directoryId: 'project:12', path: '文件.md', data: bytes('内容') }))
    .rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'list', directoryId: 'project:../12', path: '' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(readFile(join(outside, '11', '小北 #12', '文件.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('在系统中显示空项目时，定位到新建的项目根目录', async () => {
  const shown: string[] = []
  const root = join(directory, 'Gugu-data')
  files = desktopFiles(root, { ...native, reveal: path => { shown.push(path) } }, undefined, undefined, async () => ({
    name: '小北', startDate: '2026-11-20', createdAt: '2026-11-20', deletedAt: null,
  }))
  await expect(call({ action: 'reveal', directoryId: 'project:12', path: '' })).resolves.toEqual({ ok: true })
  expect(shown).toEqual([join(root, 'projects', '2026', '11', '小北 #12')])
})

it('拖入大文件和嵌套目录会移动原件，遇到同名项会保留两边', async () => {
  const root = await files.personalRoot()
  const size = 33 * 1024 * 1024
  const large = join(directory, '合成大文件.bin')
  const folder = join(directory, '合成目录')
  await writeFile(large, '')
  await truncate(large, size)
  await mkdir(join(folder, '子目录'), { recursive: true })
  await writeFile(join(folder, '子目录', '内容.txt'), '合成内容')
  await call({ action: 'move-dropped', directoryId: 'personal', path: '', sources: [large, folder] })
  expect((await lstat(join(root, basename(large)))).size).toBe(size)
  expect(await readFile(join(root, basename(folder), '子目录', '内容.txt'), 'utf8')).toBe('合成内容')
  await expect(lstat(large)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(folder)).rejects.toMatchObject({ code: 'ENOENT' })

  await writeFile(large, '同名原件')
  await expect(call({ action: 'move-dropped', path: '', sources: [large] })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(large, 'utf8')).toBe('同名原件')
  expect((await lstat(join(root, basename(large)))).size).toBe(size)
})

it('拖入操作同时保护多个应用数据目录', async () => {
  const first = join(directory, 'app'), second = join(directory, 'protected')
  await mkdir(second)
  const library = join(directory, 'library')
  await mkdir(library)
  files = desktopFiles(library, native, undefined, [first, second])
  await files.personalRoot()
  for (const source of [join(first, '配置.txt'), join(second, '私有.txt')]) {
    await writeFile(source, '保留')
    await expect(call({ action: 'move-dropped', path: '', sources: [source] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await readFile(source, 'utf8')).toBe('保留')
  }
})

it('原生拖入查询同名项后可保留两份或替换原文件', async () => {
  const root = await files.personalRoot()
  const source = join(directory, '同名.txt')
  const target = join(root, '同名.txt')
  const command = { action: 'move-dropped', path: '', sources: [source] }
  await writeFile(source, '拖入内容')
  await writeFile(target, '现有内容')
  const preview = await call({ ...command, negotiate: true }) as {
    conflict: { filename: string; canOverwrite: boolean; identity: string }
  }
  expect(preview.conflict).toMatchObject({ filename: '同名.txt', canOverwrite: true })
  expect(await readFile(source, 'utf8')).toBe('拖入内容')

  await call({ ...command, choice: 'keep_both' })
  expect(await readFile(target, 'utf8')).toBe('现有内容')
  expect(await readFile(join(root, '同名 (2).txt'), 'utf8')).toBe('拖入内容')

  await writeFile(source, '替换内容')
  await call({ ...command, choice: 'overwrite', identity: preview.conflict.identity })
  expect(await readFile(target, 'utf8')).toBe('替换内容')
  await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('项目删除移动完整目录，恢复移回原位，提交失败时回滚', async () => {
  const root = join(directory, 'Gugu-data')
  let project = { name: '交付', startDate: '2026-11-20', createdAt: '2026-11-20', deletedAt: null as string | null }
  files = desktopFiles(root, native, undefined, undefined, async () => project)
  await call({ action: 'upload', directoryId: 'project:12', path: '图稿.md', data: bytes('原文件') })
  const active = join(root, 'projects', '2026', '11', '交付 #12', '图稿.md')
  const parked = join(root, '.gugu-project-trash', '12', '图稿.md')

  await expect(files.changeProjectDirectory(12, 'delete', async () => { throw new Error('提交失败') })).rejects.toThrow('提交失败')
  expect(await readFile(active, 'utf8')).toBe('原文件')
  const remove = () => files.changeProjectDirectory(12, 'delete', async () => {
    project = { ...project, deletedAt: '2026-11-23' }
  })
  await remove()
  await expect(readFile(active)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(parked, 'utf8')).toBe('原文件')
  await files.changeProjectDirectory(12, 'restore', async () => {
    project = { ...project, deletedAt: null }
  })
  expect(await readFile(active, 'utf8')).toBe('原文件')
  await remove()
  await files.changeProjectDirectory(12, 'purge', async () => {})
  await expect(readFile(parked)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('保护个人下载目录本身，目录内的文件仍可移动和删除', async () => {
  await call({ action: 'mkdir', directoryId: 'personal', path: 'download' })
  await call({ action: 'upload', directoryId: 'personal', path: 'download/资料.txt', data: bytes('正文') })
  await expect(call({ action: 'move', directoryId: 'personal', path: 'download', destination: '其他' }))
    .rejects.toMatchObject({ code: 'forbidden' })
  await expect(call({ action: 'trash', directoryId: 'personal', path: 'download' }))
    .rejects.toMatchObject({ code: 'forbidden' })
  await call({ action: 'move', directoryId: 'personal', path: 'download/资料.txt', destination: 'download/新名称.txt' })
  await call({ action: 'trash', directoryId: 'personal', path: 'download/新名称.txt' })
  expect((await lstat(join(await files.personalRoot(), 'download'))).isDirectory()).toBe(true)
})

it('旧工作区登记迁移出稳定数字编号，删除后新增不复用旧号', async () => {
  const root = join(directory, 'Gugu-data')
  const registry = join(directory, 'app', 'workspaces.json')
  const older = join(directory, '旧目录')
  const newer = join(directory, '新目录')
  await mkdir(older)
  await mkdir(newer)
  const id = 'desktop:11111111-1111-4111-8111-111111111111'
  await writeFile(registry, JSON.stringify([{ id, name: '旧目录', root: older }]))
  files = desktopFiles(root, native, registry, join(directory, 'app'))
  await expect(files.agentWorkspaceList()).resolves.toMatchObject([{ id, commandNumber: 1 }])
  files = desktopFiles(root, native, registry, join(directory, 'app'))
  await expect(files.agentWorkspaceList()).resolves.toMatchObject([{ id, commandNumber: 1 }])
  await call({ action: 'workspace-remove', directoryId: id })
  picked = newer
  await call({ action: 'workspace-add' })
  await expect(files.agentWorkspaceList()).resolves.toMatchObject([{ name: '新目录', commandNumber: 2 }])
})

it('文件库可撤回删除和重做，恢复时保留同名文件', async () => {
  const path = '示例.txt'
  const location = join(await files.personalRoot(), path)
  await call({ action: 'upload', path, data: bytes('旧版本') })
  await call({ action: 'trash', path, undoable: true })
  await expect(lstat(location)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(location, '新版本')
  await expect(call({ action: 'undo-trash' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await readFile(location, 'utf8')).toBe('新版本')
  await rename(location, join(await files.personalRoot(), '另存.txt'))
  await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
  expect(await readFile(location, 'utf8')).toBe('旧版本')
  await expect(call({ action: 'redo-trash' })).resolves.toEqual({ changed: true })
  await expect(lstat(location)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
  expect(await readFile(location, 'utf8')).toBe('旧版本')
})

it('文件库按顺序撤销并重做新建文件夹、上传和复制', async () => {
  const root = await files.personalRoot()
  await call({ action: 'mkdir', path: '资料' })
  await call({ action: 'upload', path: '草稿.txt', data: bytes('正文') })
  await call({ action: 'copy', path: '草稿.txt', destination: '副本.txt' })

  for (const path of ['副本.txt', '草稿.txt', '资料']) {
    await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
    await expect(lstat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  for (const path of ['资料', '草稿.txt', '副本.txt']) {
    await expect(call({ action: 'redo-trash' })).resolves.toEqual({ changed: true })
    await expect(lstat(join(root, path))).resolves.toBeDefined()
  }
  expect(await readFile(join(root, '副本.txt'), 'utf8')).toBe('正文')
})

it('恢复已改名的文件后仍可撤销改名和原始上传', async () => {
  const root = await files.personalRoot()
  await call({ action: 'upload', path: '草稿.txt', data: bytes('正文') })
  await call({ action: 'move', path: '草稿.txt', destination: '定稿.txt' })
  await call({ action: 'trash', path: '定稿.txt', undoable: true })
  await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
  await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
  expect(await readFile(join(root, '草稿.txt'), 'utf8')).toBe('正文')
  await expect(call({ action: 'undo-trash' })).resolves.toEqual({ changed: true })
  await expect(lstat(join(root, '草稿.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (let step = 0; step < 3; step++)
    await expect(call({ action: 'redo-trash' })).resolves.toEqual({ changed: true })
  await expect(lstat(join(root, '定稿.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('本地图片等长改写和同名替换都会更新列表与预览版本', async () => {
  const root = await files.personalRoot()
  const path = '示例.png'
  const url = new URL('gugu-desktop://app/__local-files/content')
  url.search = new URLSearchParams({ path, metadata: '1' }).toString()
  async function revision() {
    const entries = await call({ action: 'list', path: '' }) as Array<{ name: string; revision: string }>
    const metadata = await (await files.content(url, null)).json()
    expect(metadata.revision).toBe(entries.find(entry => entry.name === path)?.revision)
    expect(metadata.revision).toEqual(expect.any(String))
    return metadata.revision
  }
  await writeFile(join(root, path), 'aaa')
  const original = await revision()
  await writeFile(join(root, path), 'bbb')
  const modified = await revision()
  expect(modified).not.toBe(original)
  await writeFile(join(root, '替换.png'), 'ccc')
  await rename(join(root, '替换.png'), join(root, path))
  expect(await revision()).not.toBe(modified)
})

it('本地目录监听推送外部保存事件，同名替换后仍能收到通知', async () => {
  const root = await files.personalRoot()
  const path = join(root, '示例.png')
  await writeFile(path, '初始内容')
  const url = new URL('gugu-desktop://app/__local-files/content?path=&watch=1')
  const response = await files.content(url, null)
  const watcher = response.body!.getReader()
  async function expectNotification() {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        watcher.read(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('未收到目录变更事件')), 3000) }),
      ])
      expect(result.done).toBe(false)
    } finally { clearTimeout(timeout) }
  }
  try {
    await expectNotification()
    await writeFile(path, '原地修改')
    await expectNotification()
    const replacement = join(root, '编辑器临时文件.png')
    await writeFile(replacement, '替换内容')
    await rename(replacement, path)
    await expectNotification()
  } finally {
    await watcher.cancel()
    watcher.releaseLock()
  }
})

it('迁移安装目录和旧文件根中的 Agent 数据，保留冲突与其他账号文件', async () => {
  const root = join(directory, 'managed'), database = join(directory, 'app')
  const owner = '5d413fad-2e23-40fa-9d72-ba9d7c58f638'
  const other = '344ee0d2-1fd0-4f72-8f84-1f593d558b7c'
  const account = join(root, owner)
  const entries = [
    [join(root, '.agent', 'memories'), 'memory.md', '旧记忆'],
    [join(account, '.agent', 'memories'), 'memory.md', '当前记忆'],
    [join(database, owner, '.agent', 'knowledge'), '合成.md', '旧知识'],
    [join(root, 'personal'), '个人.md', '个人文件'],
    [join(root, 'project'), '项目.md', '项目文件'],
    [join(root, other, '.agent'), '私有.md', '其他账号'],
  ]
  for (const [folder, name, body] of entries) {
    await mkdir(folder!, { recursive: true })
    await writeFile(join(folder!, name!), body!)
  }
  expect(await prepareDesktopOwnerFiles(root, database, owner)).toBe(account)
  expect(await readFile(join(account, '.agent', 'memories', 'memory.md'), 'utf8')).toBe('当前记忆')
  const [conflict] = await readdir(join(account, '.migration-conflicts'))
  expect(await readFile(join(account, '.migration-conflicts', conflict!, 'memory.md'), 'utf8')).toBe('旧记忆')
  expect(await readFile(join(account, '.agent', 'knowledge', '合成.md'), 'utf8')).toBe('旧知识')
  expect(await readFile(join(account, 'personal', '个人.md'), 'utf8')).toBe('个人文件')
  expect(await readFile(join(account, 'projects', '项目.md'), 'utf8')).toBe('项目文件')
  await expect(lstat(join(root, '.agent'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await prepareDesktopOwnerFiles(root, database, other)).toBe(join(root, other))
  expect(await readFile(join(root, other, '.agent', '私有.md'), 'utf8')).toBe('其他账号')
})
