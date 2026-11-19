import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLocalUndoRetentionStorage } from '../../src/modules/files/storage/undo.js'

const owner = '11111111-1111-4111-8111-111111111111'

test('本地 Undo 正文清理仅删除 owner 的操作目录，不跟随目录符号链接', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-undo-retention-path-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-undo-retention-outside-'))
  const operationId = `op-${'d'.repeat(32)}`
  const prefix = `${owner}/.undo/${operationId}`
  const artifact = path.join(root, prefix, 'file-1', 'before')
  const outsideFile = path.join(outside, 'keep')
  try {
    await mkdir(path.dirname(artifact), { recursive: true })
    await writeFile(artifact, '正文')
    await writeFile(outsideFile, '外部文件')
    const storage = createLocalUndoRetentionStorage(root)
    await assert.rejects(storage.removePrefix(owner, `${owner}/.undo/../../outside`))
    await assert.rejects(storage.removePrefix('22222222-2222-4222-8222-222222222222', prefix))
    assert.equal(await storage.removePrefix(owner, prefix), 1)
    await assert.rejects(readFile(artifact))
    assert.equal(await readFile(outsideFile, 'utf8'), '外部文件')

    const linkedRoot = path.join(root, `${owner}/.undo/${operationId}`)
    await mkdir(path.dirname(linkedRoot), { recursive: true })
    await symlink(outside, linkedRoot)
    assert.equal(await storage.removePrefix(owner, prefix), 0)
    await assert.rejects(readFile(path.join(linkedRoot, 'keep')))
    assert.equal(await readFile(outsideFile, 'utf8'), '外部文件')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
