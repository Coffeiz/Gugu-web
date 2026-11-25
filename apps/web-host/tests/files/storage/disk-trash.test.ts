import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDiskTrash } from '../../../src/modules/files/trash/disk.js'
import { purgeExpiredDiskTrash } from '../../../src/modules/files/trash/retention.js'

const owner = '22345678-abcd-4ef0-8012-123456789123'
const other = '12345678-abcd-4ef0-8012-123456789123'

test('路径回收站按授权目录移动实体、拒绝覆盖并按保留期清理', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-path-trash-'))
  const personal = `${owner}/个人文件`
  const source = `${personal}/原件.txt`
  const destination = `${personal}/冲突.txt`
  const trash = createDiskTrash(root, async (ownerId, directory) => {
    assert.equal(directory, 'personal')
    return `${ownerId}/个人文件`
  })
  try {
    await mkdir(join(root, personal), { recursive: true })
    await writeFile(join(root, source), '回收内容')
    const item = await trash.store(owner, 'personal', '原件.txt', source, '2026-01-01T00:00:00.000Z')
    assert.ok(item)
    assert.equal(item.kind, 'file')
    assert.deepEqual((await trash.list(owner)).map(entry => entry.id), [item.id])
    assert.deepEqual(await trash.list(other), [])

    await writeFile(join(root, destination), '冲突文件')
    await assert.rejects(trash.restore(owner, item.id), { code: 'EEXIST' })
    assert.equal(await readFile(join(root, destination), 'utf8'), '冲突文件')
    await unlink(join(root, destination))
    assert.equal(await trash.restore(owner, item.id), true)
    assert.equal(await readFile(join(root, source), 'utf8'), '回收内容')
    assert.deepEqual(await trash.list(owner), [])

    await writeFile(join(root, `${personal}/到期.txt`), '到期')
    await writeFile(join(root, `${personal}/未到期.txt`), '未到期')
    await trash.store(owner, 'personal', '到期.txt', `${personal}/到期.txt`, '2026-01-01T00:00:00.000Z')
    await trash.store(owner, 'personal', '未到期.txt', `${personal}/未到期.txt`, '2026-01-01T00:00:00.001Z')
    assert.equal(await purgeExpiredDiskTrash(trash, owner, new Date('2026-01-31T00:00:00Z')), 1)
    assert.deepEqual((await trash.list(owner)).map(entry => entry.name), ['未到期.txt'])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
