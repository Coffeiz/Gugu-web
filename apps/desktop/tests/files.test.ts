import { createProjectWorkspaceBindingTool } from '../../../packages/core/src/agent/tools/workspaces.js'
import { createToolRegistry } from '../../../packages/core/src/agent/tools/registry.js'
import { shouldOpenFileInSystem } from '@gugu/desktop-contracts/file-preview'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
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
  await expect(readFile(join(root, 'project', '2026', '11', '小北_设计 #12', path))).rejects.toMatchObject({ code: 'ENOENT' })
  await call({ action: 'upload', directoryId: id, path, data: bytes('原文件') })
  const original = join(root, 'project', '2026', '11', '小北_设计 #12', path)
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
  expect(await readFile(join(root, 'project', '2027', '01', '交付 #12', path), 'utf8')).toBe('原文件')

  project = { ...project, deletedAt: '2027-02-01' }
  await expect(call({ action: 'list', directoryId: id, path: '' })).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.content(url, null)).rejects.toMatchObject({ code: 'not_found' })
  await expect(files.resolveFileForDrag(id, path)).rejects.toMatchObject({ code: 'not_found' })
})

it('项目目录解析拒绝链接年月目录与工作区外路径', async () => {
  const root = join(directory, 'Gugu-data')
  const outside = join(directory, '外部目录')
  await mkdir(join(root, 'project'), { recursive: true })
  await mkdir(outside)
  await symlink(outside, join(root, 'project', '2026'), 'junction')
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
  expect(shown).toEqual([join(root, 'project', '2026', '11', '小北 #12')])
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
  const active = join(root, 'project', '2026', '11', '交付 #12', '图稿.md')
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
