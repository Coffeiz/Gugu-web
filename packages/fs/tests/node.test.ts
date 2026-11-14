import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openLocalFile, UnsafeLocalPathError } from '../src/node.js'

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
