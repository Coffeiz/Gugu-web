import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { openAuthorizedRelativeFile } from '@gugu/core/files/read'

test('受控根读取正文，拒绝越界及符号链接，并保留系统读取错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-path-read-'))
  try {
    await writeFile(join(root, 'note.txt'), '正文')
    await symlink(join(root, 'note.txt'), join(root, 'link'))
    const open = (key: string) => openLocalFile(root, key)
    const unsafe = (error: unknown) => error instanceof UnsafeLocalPathError
    const opened = await openAuthorizedRelativeFile('note.txt', open, unsafe)
    assert.equal(await opened!.handle.readFile('utf8'), '正文')
    await opened!.handle.close()
    assert.equal(await openAuthorizedRelativeFile('missing', open, unsafe), null)
    for (const path of ['../note.txt', '/note.txt', 'a//b', 'a\\b', 'link'])
      await assert.rejects(openAuthorizedRelativeFile(path, open, unsafe), { code: 'not_found' })
    const denied = Object.assign(new Error('拒绝'), { code: 'EACCES' })
    await assert.rejects(openAuthorizedRelativeFile('note.txt', async () => { throw denied }, unsafe), error => error === denied)
  } finally { await rm(root, { recursive: true, force: true }) }
})
