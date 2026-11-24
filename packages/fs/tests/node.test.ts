import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, skipIf } from 'vitest'
import { createLocalFileTree, finishStagedLocalFile, importLocalFile, openLocalFile, removeLocalTree, stageLocalFile, UnsafeLocalPathError, writeLocalFile, writeLocalFileStream } from '../src/node.js'

const root = await mkdtemp(path.join(tmpdir(), 'gugu-fs-'))
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('本地文件树只用路径解析根内位置，不暴露 storage key 别名', () => {
  const tree = createLocalFileTree(root, 'owner')
  expect(tree.path('docs/notes.txt')).toBe('owner/docs/notes.txt')
  expect(() => tree.path('../outside.txt')).toThrow(UnsafeLocalPathError)
  expect(tree).not.toHaveProperty('storageKey')
})

it('只读取授权根内的普通文件，拒绝穿越和符号链接', async () => {
  await mkdir(path.join(root, 'owner'))
  await writeFile(path.join(root, 'owner', 'a'), '内容')
  await symlink(path.join(root, 'owner', 'a'), path.join(root, 'owner', 'link'))
  const result = await openLocalFile(root, 'owner/a')
  expect(await result!.handle.readFile('utf8')).toBe('内容')
  await result!.handle.close()
  expect(await openLocalFile(root, 'owner/missing')).toBeNull()
  await expect(openLocalFile(root, '../outside')).rejects.toBeInstanceOf(UnsafeLocalPathError)
  await expect(openLocalFile(root, 'owner/link')).rejects.toBeInstanceOf(UnsafeLocalPathError)
  await expect(openLocalFile(root, 'owner')).rejects.toBeInstanceOf(UnsafeLocalPathError)
})

it.skipIf(process.platform !== 'linux')('暂存和恢复不覆盖已有目标，保留中断后同一 inode 的内容', async () => {
  await mkdir(root, { recursive: true })
  const id = '00000000-0000-4000-8000-000000000001'
  const file = path.join(root, 'a')
  await writeFile(file, '旧文件')
  const staged = await stageLocalFile(root, 'a', id)
  await writeFile(file, '新文件')
  await expect(finishStagedLocalFile(root, 'a', id, true)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('新文件')
  await rm(file)
  await link(staged!.stagedPath, file)
  await finishStagedLocalFile(root, 'a', id, true)
  expect(await readFile(file, 'utf8')).toBe('旧文件')
  await expect(readFile(staged!.stagedPath)).rejects.toThrow()
})

it.skipIf(process.platform !== 'linux')('暂存拒绝越界、符号链接和已存在的暂存目标', async () => {
  await mkdir(root, { recursive: true })
  const id = '00000000-0000-4000-8000-000000000001'
  await writeFile(path.join(root, 'a'), '正文')
  await symlink(path.join(root, 'a'), path.join(root, 'alias'))
  await expect(stageLocalFile(root, '../a', id)).rejects.toBeInstanceOf(UnsafeLocalPathError)
  await expect(stageLocalFile(root, 'alias', id)).rejects.toBeInstanceOf(UnsafeLocalPathError)
  await writeFile(path.join(root, `a.gugu-purge-${id}`), '保留')
  await expect(stageLocalFile(root, 'a', id)).rejects.toThrow()
  expect(await readFile(path.join(root, `a.gugu-purge-${id}`), 'utf8')).toBe('保留')
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('正文')
})

it('锚定存储根递归删除指定用户前缀，不触碰相邻用户或符号链接目标', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-fs-outside-'))
  try {
    await mkdir(path.join(root, 'owner', 'nested'), { recursive: true })
    await mkdir(path.join(root, 'other'), { recursive: true })
    await writeFile(path.join(root, 'owner', 'nested', 'data'), '删除')
    await writeFile(path.join(root, 'other', 'data'), '保留')
    await writeFile(path.join(outside, 'data'), '越界保留')
    await symlink(outside, path.join(root, 'owner', 'link'))

    expect(await removeLocalTree(root, 'owner')).toBe(1)
    await expect(readFile(path.join(root, 'owner', 'nested', 'data'))).rejects.toThrow()
    expect(await readFile(path.join(root, 'other', 'data'), 'utf8')).toBe('保留')
    expect(await readFile(path.join(outside, 'data'), 'utf8')).toBe('越界保留')
  } finally { await rm(outside, { recursive: true, force: true }) }
})

it('递归删除拒绝根目录和不安全相对路径，缺失目标幂等', async () => {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'sibling.txt'), '保留')
  await expect(removeLocalTree(root, '.')).rejects.toBeInstanceOf(UnsafeLocalPathError)
  await expect(removeLocalTree(root, '../outside')).rejects.toBeInstanceOf(UnsafeLocalPathError)
  expect(await removeLocalTree(root, 'missing')).toBe(0)
  expect(await readFile(path.join(root, 'sibling.txt'), 'utf8')).toBe('保留')
})

it.skipIf(process.platform !== 'linux')('原子写入授权根内的嵌套文件并拒绝越界或符号链接父目录', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-fs-outside-'))
  try {
    await mkdir(root, { recursive: true })
    await writeLocalFile(root, 'owner/.agent/memory_vec.json', '{"safe":true}')
    expect(await readFile(path.join(root, 'owner/.agent/memory_vec.json'), 'utf8')).toBe('{"safe":true}')
    await expect(writeLocalFile(root, '../outside', '越界')).rejects.toBeInstanceOf(UnsafeLocalPathError)
    await symlink(outside, path.join(root, 'linked'))
    await expect(writeLocalFile(root, 'linked/data.json', '越界')).rejects.toBeInstanceOf(UnsafeLocalPathError)
    await expect(readFile(path.join(outside, 'data.json'))).rejects.toThrow()
  } finally { await rm(outside, { recursive: true, force: true }) }
})


it.skipIf(process.platform !== 'linux')('流式导入完整后才发布，并发同名不覆盖，失败仅清理暂存内容', async () => {
  await mkdir(root, { recursive: true })
  await mkdir(path.join(root, 'imports'))
  const controller = new AbortController()
  const destination = path.join(root, 'imports', 'source.txt')
  async function* data() {
    yield Buffer.from('第一段')
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    yield Buffer.from('第二段')
  }
  await importLocalFile(root, 'imports/source.txt', data(), controller.signal)
  expect(await readFile(destination, 'utf8')).toBe('第一段第二段')
  async function* collision() {
    yield Buffer.from('不得覆盖')
    await writeFile(path.join(root, 'imports', 'collision.txt'), '并发创建')
  }
  await expect(importLocalFile(root, 'imports/collision.txt', collision(), controller.signal)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path.join(root, 'imports', 'collision.txt'), 'utf8')).toBe('并发创建')
  async function* interrupted() {
    yield Buffer.from('不完整正文')
    controller.abort()
    yield Buffer.from('不得发布')
  }
  await expect(importLocalFile(root, 'imports/cancelled.txt', interrupted(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect((await readdir(path.join(root, 'imports'))).sort()).toEqual(['collision.txt', 'source.txt'])
})

it.skipIf(process.platform !== 'linux')('显式覆盖只发布完整文件，并保护途中被修改的目标', async () => {
  await mkdir(path.join(root, 'imports'), { recursive: true })
  const relative = 'imports/source.txt'
  const destination = path.join(root, relative)
  await writeFile(destination, '原内容')
  const { signal } = new AbortController()
  async function* interrupted() {
    yield Buffer.from('不完整正文')
    throw new Error('上传中断')
  }
  await expect(importLocalFile(root, relative, interrupted(), signal, true)).rejects.toThrow('上传中断')
  expect(await readFile(destination, 'utf8')).toBe('原内容')
  async function* concurrent() {
    yield Buffer.from('本次上传')
    await writeFile(destination, '其他端修改')
  }
  await expect(importLocalFile(root, relative, concurrent(), signal, true)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(destination, 'utf8')).toBe('其他端修改')
  async function* data() { yield Buffer.from('新正文') }
  await importLocalFile(root, relative, data(), signal, true)
  expect(await readFile(destination, 'utf8')).toBe('新正文')
  expect(await readdir(path.join(root, 'imports'))).toEqual(['source.txt'])
})

it.skipIf(process.platform !== 'linux')('流式导入拒绝不存在的目标目录和符号链接父目录', async () => {
  await mkdir(root, { recursive: true })
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-fs-outside-'))
  try {
    await symlink(outside, path.join(root, 'escape'))
    const body = async function* () { yield Buffer.from('正文') }
    const { signal } = new AbortController()
    await expect(importLocalFile(root, 'escape/file', body(), signal)).rejects.toBeInstanceOf(UnsafeLocalPathError)
    await expect(importLocalFile(root, 'missing/file', body(), signal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(outside)).toEqual([])
  } finally { await rm(outside, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'linux')('流式暂存自动创建安全父目录，不覆盖已有文件或跟随符号链接', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-fs-outside-'))
  try {
    await mkdir(root, { recursive: true })
    const signal = new AbortController().signal
    const body = async function* () { yield Buffer.from('encrypted archive') }
    await writeLocalFileStream(root, 'owner/.data-portability/imports/job.gupi', body(), signal)
    expect(await readFile(path.join(root, 'owner/.data-portability/imports/job.gupi'), 'utf8')).toBe('encrypted archive')
    await expect(writeLocalFileStream(root, 'owner/.data-portability/imports/job.gupi', body(), signal)).rejects.toMatchObject({ code: 'EEXIST' })
    await symlink(outside, path.join(root, 'escape'))
    await expect(writeLocalFileStream(root, 'escape/job.gupi', body(), signal)).rejects.toBeInstanceOf(UnsafeLocalPathError)
    expect(await readdir(outside)).toEqual([])
  } finally { await rm(outside, { recursive: true, force: true }) }
})
