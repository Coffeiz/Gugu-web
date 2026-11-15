import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { finishStagedLocalFile, openLocalFile, removeLocalTree, stageLocalFile, UnsafeLocalPathError } from '../src/node.js'

const root = await mkdtemp(path.join(tmpdir(), 'gugu-fs-'))
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
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

it('暂存和恢复不覆盖已有目标，保留中断后同一 inode 的内容', async () => {
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

it('暂存拒绝越界、符号链接和已存在的暂存目标', async () => {
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
