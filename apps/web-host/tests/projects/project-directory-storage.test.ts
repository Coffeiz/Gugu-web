import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLocalProjectDirectoryRenamer, renameLocalProjectDirectory } from '../../src/modules/projects/update.js'

async function temporaryRoot(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('没有原子不覆盖目录原语时拒绝改名，源树和权限保持不变', async t => {
  const root = await temporaryRoot(t)
  const oldPrefix = 'owner/项目文件/2026/11/旧项目 #7', newPrefix = 'owner/项目文件/2026/11/新项目 #7'
  const source = path.join(root, oldPrefix), nested = path.join(source, '嵌套目录')
  await mkdir(nested, { recursive: true, mode: 0o700 })
  await writeFile(path.join(nested, '资料.txt'), '内容', { mode: 0o600 })
  const before = await stat(nested)
  await assert.rejects(createLocalProjectDirectoryRenamer(root)('owner', oldPrefix, newPrefix), { code: 'ENOTSUP' })
  assert.equal(await readFile(path.join(nested, '资料.txt'), 'utf8'), '内容')
  const after = await stat(nested)
  assert.equal(after.mode, before.mode)
  assert.equal(after.gid, before.gid)
  await assert.rejects(stat(path.join(root, newPrefix)), { code: 'ENOENT' })
})

test('目录目标在预检查后出现也不覆盖，反向移动同样保留两棵目录', async t => {
  const root = await temporaryRoot(t)
  const oldPrefix = 'owner/原项目 #17', newPrefix = 'owner/新项目 #17'
  await mkdir(path.join(root, oldPrefix), { recursive: true })
  await writeFile(path.join(root, oldPrefix, '说明.txt'), '原目录正文')
  let called = false
  await assert.rejects(renameLocalProjectDirectory(root, oldPrefix, newPrefix, async () => {
    await mkdir(path.join(root, newPrefix))
    await writeFile(path.join(root, newPrefix, '保留.txt'), '并发目录正文')
    called = true
  }), { code: 'ENOTSUP' })
  assert.equal(called, true)
  await assert.rejects(renameLocalProjectDirectory(root, newPrefix, oldPrefix), { code: 'ENOTSUP' })
  assert.equal(await readFile(path.join(root, oldPrefix, '说明.txt'), 'utf8'), '原目录正文')
  assert.equal(await readFile(path.join(root, newPrefix, '保留.txt'), 'utf8'), '并发目录正文')
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
  await symlink(path.join(outside, 'source'), path.join(root, 'owner', 'source-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(outside, path.join(root, 'owner', 'target-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const rename = createLocalProjectDirectoryRenamer(root)

  await assert.rejects(rename('owner', 'owner/source-link', 'owner/moved'), /符号链接/)
  await assert.rejects(rename('owner', 'owner/missing', 'owner/target-link/moved'), /符号链接/)
  assert.equal(await readFile(path.join(outside, 'source', 'secret.txt'), 'utf8'), 'outside')
})
