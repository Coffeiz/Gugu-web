import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupStaleWebDownloadStaging } from '../../../../src/modules/agent/tools/files/download.js'

test('Web 下载启动时只清理过期工具暂存，不碰新目录或符号链接目标', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-web-download-cleanup-test-'))
  try {
    const now = Date.now()
    const stale = join(root, 'gugu-web-download-stale')
    const recent = join(root, 'gugu-web-download-recent')
    const link = join(root, 'gugu-web-download-link')
    const linkTarget = join(root, 'unrelated-target')
    await Promise.all([mkdir(stale), mkdir(recent), mkdir(linkTarget)])
    await writeFile(join(linkTarget, 'keep.txt'), '保留')
    await utimes(stale, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000))
    await symlink(linkTarget, link)

    const removed = await cleanupStaleWebDownloadStaging({ root, now, uid: process.getuid?.() })
    assert.equal(removed, 1)
    await assert.rejects(readFile(join(stale, 'missing')))
    assert.equal((await readFile(join(linkTarget, 'keep.txt'), 'utf8')), '保留')
    assert.equal((await lstat(link)).isSymbolicLink(), true)
    assert.equal(await cleanupStaleWebDownloadStaging({ root, now, uid: process.getuid?.() }), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
