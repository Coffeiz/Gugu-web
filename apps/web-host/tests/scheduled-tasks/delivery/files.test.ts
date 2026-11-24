import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { createWebScheduledAttachmentResources } from '../../../src/modules/scheduled-tasks/delivery/files.js'

test('定时投递只打开当前属主的路径文件，拒绝旧 ID 和跨属主路径', { skip: process.platform !== 'linux' && '路径文件服务需要 Linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-scheduled-file-'))
  const owner = '11111111-1111-4111-8111-111111111111'
  const other = '22222222-2222-4222-8222-222222222222'
  const signal = new AbortController().signal
  try {
    await mkdir(join(root, owner, '个人文件'), { recursive: true })
    await writeFile(join(root, owner, '个人文件', '报告.txt'), 'report')
    const pool = {
      async query(statement: string) {
        assert.match(statement, /FROM (projects|workspace_directories) WHERE/u)
        return { rows: [] }
      },
    } as unknown as Pick<Pool, 'query'>
    const resources = createWebScheduledAttachmentResources(root,
      async () => assert.fail('路径文件不读聊天附件'),
      {
        open: async () => assert.fail('路径文件不发起网络请求'),
        stage: async () => assert.fail('路径文件不创建临时附件'),
      }, pool)
    const tool = resources.toolForRun(async () => true)
    const input = { file: '/personal/报告.txt' }
    const result = await tool.execute(input, {
      identity: { ownerId: owner, sessionId: '1', runId: 'run' },
      roundId: 'round', signal, resolution: null,
      execute: async () => assert.fail('投递不调用 Shell'),
    }, { id: 'file', name: 'send_item', input })
    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    assert.equal(result.successful, true)
    assert.deepEqual(result.artifact, { file_path: input.file, name: '报告', ext: 'txt', size_bytes: 6 })
    const opened = await resources.read(owner, result.artifact, () => 10, signal)
    assert.equal(opened?.filename, '报告.txt')
    assert.equal(new TextDecoder().decode(opened?.bytes), 'report')
    assert.equal(await resources.read(other, result.artifact, () => 10, signal), null)
    assert.equal(await resources.read(owner, result.artifact, () => 5, signal), null)
    assert.equal(await resources.read(owner, { file_id: 1 }, () => 10, signal), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
