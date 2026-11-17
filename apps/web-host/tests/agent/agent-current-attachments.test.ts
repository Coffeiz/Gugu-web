import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createWebCurrentMessageMaterializer } from '../../src/domains/agent-sessions/context/agent-current-message.js'
import { createCurrentMessageAttachmentReader } from '../../src/domains/agent-sessions/context/agent-current-attachments.js'

function poolFor(owner: string, messageId: number, row: Record<string, unknown>) {
  const calls: Array<{ values: unknown[] }> = []
  return {
    calls,
    async query(_sql: string, values: unknown[]) {
      calls.push({ values })
      return { rows: values[0] === owner && values[1] === messageId ? [row] : [] }
    },
  }
}

test('当前消息只读取 owner 与消息均匹配的已认领附件正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-attachment-'))
  const key = 'owner-a/.chat_staging/file.txt'
  await mkdir(path.join(root, 'owner-a/.chat_staging'), { recursive: true })
  await writeFile(path.join(root, key), '合成附件正文', { mode: 0o600 })
  const row = {
    attach_id: 'attachment-a', name: '说明', ext: 'txt', mime: 'text/plain', size: Buffer.byteLength('合成附件正文'),
    storage_key: key, kind: 'text', duration: null, img_width: null, img_height: null, extra: null,
    state: 'attached', message_id: 7,
  }
  const pool = poolFor('owner-a', 7, row)
  try {
    const read = createCurrentMessageAttachmentReader({ pool, storageRoot: root })
    const result = await read('owner-a', '7', [{ attach_id: 'attachment-a' }])
    assert.equal(result.attachments.length, 1)
    assert.equal(await result.readText(result.attachments[0]!), '合成附件正文')
    assert.deepEqual(pool.calls[0]?.values, ['owner-a', 7])

    const otherOwner = await read('owner-b', '7', [{ attach_id: 'attachment-a' }])
    assert.deepEqual(otherOwner.attachments, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('元数据大小超限或与实际文件不符时不读取附件正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-attachment-'))
  const key = 'owner-a/.chat_staging/file.txt'
  await mkdir(path.join(root, 'owner-a/.chat_staging'), { recursive: true })
  await writeFile(path.join(root, key), 'tiny')
  const base = {
    attach_id: 'attachment-a', name: '说明', ext: 'txt', mime: 'text/plain', storage_key: key,
    kind: 'text', duration: null, img_width: null, img_height: null, extra: null,
    state: 'attached', message_id: 7,
  }
  try {
    const tooLarge = createCurrentMessageAttachmentReader({
      pool: poolFor('owner-a', 7, { ...base, size: 33 * 1024 * 1024 }), storageRoot: root,
    })
    const overLimit = await tooLarge('owner-a', '7', [{ attach_id: 'attachment-a' }])
    await assert.rejects(overLimit.readText(overLimit.attachments[0]!), /超限/)

    const stale = createCurrentMessageAttachmentReader({
      pool: poolFor('owner-a', 7, { ...base, size: 5 }), storageRoot: root,
    })
    const changed = await stale('owner-a', '7', [{ attach_id: 'attachment-a' }])
    await assert.rejects(changed.readText(changed.attachments[0]!), /大小与元数据不匹配/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('当前消息物化器将认证 owner 已认领文本附件注入模型正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-message-attachment-'))
  const owner = 'owner-a', key = `${owner}/.chat_staging/file.txt`
  await mkdir(path.join(root, `${owner}/.chat_staging`), { recursive: true })
  await writeFile(path.join(root, key), '来自临时文件的合成正文', { mode: 0o600 })
  const card = { attach_id: 'attachment-a', name: '说明', ext: 'txt', size_bytes: 30, kind: 'text', upload: true }
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM conversation_messages')) return { rows: [{
        content: '请阅读附件', content_json: null, files: [card], references_json: null,
      }] }
      if (sql.includes('FROM chat_attachments')) return { rows: [{
        ...card, mime: 'text/plain', size: Buffer.byteLength('来自临时文件的合成正文'), storage_key: key,
        state: 'attached', message_id: 9, duration: null, img_width: null, img_height: null, extra: null,
      }] }
      throw new Error('unexpected query')
    },
  } as unknown as Pick<Pool, 'query'>
  try {
    const materialize = createWebCurrentMessageMaterializer(pool, { storageRoot: root })
    const result = await materialize({ ownerId: owner, sessionId: '2', runId: 'run-a' }, {
      id: '9', content: 'caller supplied content is ignored', contentJson: null, files: [card], references: null,
    })
    assert.equal(result.currentUser?.persistedMessageId, '9')
    assert.match(result.currentUser?.rawText ?? '', /请阅读附件/)
    assert.match(result.currentUser?.rawText ?? '', /来自临时文件的合成正文/)
    assert.equal(result.currentUser?.message.content, result.currentUser?.rawText)
  } finally { await rm(root, { recursive: true, force: true }) }
})
