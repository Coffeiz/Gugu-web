import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createFileMigrationStorage } from '../../src/modules/files/storage/migration.js'
import { createDiskTrash } from '../../src/modules/files/trash/disk.js'
import { purgeExpiredDiskTrash } from '../../src/modules/files/trash/retention.js'
import { createPostgresFileReadOperations } from '../../src/modules/files/browse.js'
import type { Pool } from 'pg'

const owner = '22345678-abcd-4ef0-8012-123456789123'
const other = '12345678-abcd-4ef0-8012-123456789123'

test('旧文件标识在隔离磁盘中仍可打开，还原失败保留冲突双方，成功后可重复调用', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-migration-'))
  const source = `${owner}/trash/样本.txt`
  const destination = `${owner}/个人文件/样本.txt`
  try {
    await mkdir(join(root, owner, 'trash'), { recursive: true })
    await mkdir(join(root, owner, '个人文件'), { recursive: true })
    await writeFile(join(root, source), '回收内容')
    await writeFile(join(root, destination), '同名文件')
    const migration = createFileMigrationStorage(root)
    const entry = {
      id: 17, storageKey: source, restoreKey: destination,
      displayName: '样本', deletedAt: '2026-01-01T00:00:00Z',
    }
    await assert.rejects(migration.install(other, entry), (error: unknown) =>
      error instanceof CoreError && error.code === 'invalid_request')
    await migration.install(owner, entry)
    await migration.install(owner, entry)
    assert.equal(await migration.openReference(other, entry.id), null)
    assert.equal(await migration.openReference(owner, entry.id), null)
    await assert.rejects(migration.restore(owner, entry.id), (error: unknown) =>
      error instanceof CoreError && error.code === 'conflict')
    assert.equal(await readFile(join(root, source), 'utf8'), '回收内容')
    assert.equal(await readFile(join(root, destination), 'utf8'), '同名文件')

    await unlink(join(root, destination))
    await migration.restore(owner, entry.id)
    await migration.restore(owner, entry.id)
    await migration.install(owner, entry)
    const reference = await migration.openReference(owner, entry.id)
    assert.ok(reference)
    try {
      assert.equal(await reference.handle.readFile('utf8'), '回收内容')
    } finally { await reference.handle.close() }
    await assert.rejects(readFile(join(root, source)), { code: 'ENOENT' })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('旧回收项导入可重跑，还原冲突不覆盖，同一个历史 ID 可读取改名后的文件', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-trash-migration-'))
  const personal = `${owner}/个人文件`
  const storageKey = `${owner}/trash/原件.txt`
  const restoreKey = `${personal}/原件.txt`
  const deletedAt = '2026-01-01T00:00:00.000Z'
  const fileId = 29
  try {
    await mkdir(join(root, owner, 'trash'), { recursive: true })
    await mkdir(join(root, personal), { recursive: true })
    await writeFile(join(root, storageKey), '回收内容')
    const migration = createFileMigrationStorage(root)
    await migration.install(owner, { id: fileId, displayName: '原件', storageKey, restoreKey, deletedAt })
    const trash = createDiskTrash(root, async ownerId => `${ownerId}/个人文件`)
    const id = await trash.importLegacy(owner, fileId, 'personal', '原件.txt', storageKey, deletedAt)
    assert.equal(await trash.importLegacy(owner, fileId, 'personal', '原件.txt', storageKey, deletedAt), id)
    assert.deepEqual((await trash.list(owner)).map(entry => [entry.id, entry.deletedAt]), [[id, deletedAt]])
    assert.deepEqual(await trash.list(other), [])

    const pool = { query() { assert.fail('已迁移的 ID 不能回查文件表') } } as unknown as Pool
    const reader = createPostgresFileReadOperations(pool, null, root)
    assert.equal(await reader.openContent(owner, fileId), null)
    await writeFile(join(root, restoreKey), '不同文件')
    await assert.rejects(trash.restore(owner, id), { code: 'EEXIST' })
    assert.equal(await readFile(join(root, restoreKey), 'utf8'), '不同文件')
    await unlink(join(root, restoreKey))
    assert.equal(await trash.restore(owner, id), true)
    await rename(join(root, restoreKey), join(root, personal, '改名.txt'))
    await writeFile(join(root, restoreKey), '占用旧路径的文件')
    assert.deepEqual((await reader.getFileLocation(owner, fileId) as { pathFile: unknown }).pathFile,
      { directoryId: 'personal', relativePath: '改名.txt' })
    const opened = await reader.openContent(owner, fileId)
    assert.ok(opened)
    try { assert.equal(await opened.handle.readFile('utf8'), '回收内容') }
    finally { await opened.handle.close() }

    await writeFile(join(root, personal, '到期.txt'), '到期')
    await writeFile(join(root, personal, '未到期.txt'), '未到期')
    await trash.store(owner, 'personal', '到期.txt', `${personal}/到期.txt`, deletedAt)
    await trash.store(owner, 'personal', '未到期.txt', `${personal}/未到期.txt`, '2026-01-01T00:00:00.001Z')
    assert.equal(await purgeExpiredDiskTrash(trash, owner, new Date('2026-01-31T00:00:00Z')), 1)
    assert.deepEqual((await trash.list(owner)).map(entry => entry.name), ['未到期.txt'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
