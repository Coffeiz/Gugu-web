import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLocalProjectDirectoryRenamer } from '../../src/domains/projects/persistence/project-directory-storage.js'

async function temporaryRoot(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('本地项目目录改名移动整棵树并为目录/文件继承 group rw(X)', async (t) => {
  const root = await temporaryRoot(t)
  const oldPath = path.join(root, 'owner', '项目文件', '2026', '11', '旧项目 #7')
  const nested = path.join(oldPath, '嵌套目录')
  const destinationParent = path.join(root, 'owner', '项目文件', '2026', '12')
  await mkdir(nested, { recursive: true, mode: 0o700 })
  await writeFile(path.join(nested, '资料.txt'), '内容', { mode: 0o600 })
  const newPrefix = 'owner/项目文件/2026/12/新项目 #7'

  await createLocalProjectDirectoryRenamer(root)('owner', 'owner/项目文件/2026/11/旧项目 #7', newPrefix)

  const moved = path.join(root, newPrefix)
  const newNested = path.join(moved, '嵌套目录')
  const newFile = path.join(newNested, '资料.txt')
  assert.equal(await readFile(newFile, 'utf8'), '内容')
  assert.equal(await stat(oldPath).then(() => true, () => false), false)
  assert.equal(await readdir(destinationParent).then((names) => names.includes('新项目 #7')), true)
  for (const directory of [moved, newNested]) {
    const mode = (await stat(directory)).mode
    assert.equal(mode & 0o070, 0o070)
    assert.equal(mode & 0o007, 0, '不得新增 world 权限')
  }
  const fileMode = (await stat(newFile)).mode
  assert.equal(fileMode & 0o060, 0o060)
  assert.equal(fileMode & 0o007, 0, '不得新增 world 权限')
  const targetGid = (await stat(destinationParent)).gid
  assert.equal((await stat(moved)).gid, targetGid)
  assert.equal((await stat(newNested)).gid, (await stat(moved)).gid)
  assert.equal((await stat(newFile)).gid, (await stat(newNested)).gid)
})

test('源目录不存在时静默返回且不创建目标父目录', async (t) => {
  const root = await temporaryRoot(t)
  await createLocalProjectDirectoryRenamer(root)('owner', 'owner/missing', 'owner/new-parent/new-name')
  assert.equal(await stat(path.join(root, 'owner', 'new-parent')).then(() => true, () => false), false)
})

test('本地项目目录改名拒绝绝对路径和 root 外的路径遍历', async (t) => {
  const root = await temporaryRoot(t)
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`)
  await mkdir(outside)
  t.after(() => rm(outside, { recursive: true, force: true }))
  const rename = createLocalProjectDirectoryRenamer(root)

  await assert.rejects(rename('owner', '../outside', 'owner/new'), /相对路径|路径范围/)
  await assert.rejects(rename('owner', 'owner/missing', '../../outside/new'), /相对路径|路径范围/)
  await assert.rejects(rename('owner', '/etc', 'owner/new'), /相对路径|路径范围/)
  assert.equal(await stat(path.join(outside, 'new')).then(() => true, () => false), false)
})

test('本地项目目录改名拒绝源树和目标父路径中的符号链接', async (t) => {
  const root = await temporaryRoot(t)
  const outside = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(path.join(outside, 'source'), { recursive: true })
  await writeFile(path.join(outside, 'source', 'secret.txt'), 'outside')
  await mkdir(path.join(root, 'owner'))
  await symlink(path.join(outside, 'source'), path.join(root, 'owner', 'source-link'))
  await symlink(outside, path.join(root, 'owner', 'target-link'))
  const rename = createLocalProjectDirectoryRenamer(root)

  await assert.rejects(rename('owner', 'owner/source-link', 'owner/moved'), /符号链接/)
  await assert.rejects(rename('owner', 'owner/missing', 'owner/target-link/moved'), /符号链接/)
  assert.equal(await readFile(path.join(outside, 'source', 'secret.txt'), 'utf8'), 'outside')
})
