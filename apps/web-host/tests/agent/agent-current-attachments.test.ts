import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createWebCurrentMessageMaterializer } from '../../src/modules/agent-sessions/context/agent-current-message.js'
import { createCurrentMessageAttachmentReader } from '../../src/modules/agent-sessions/context/agent-current-attachments.js'

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

test('文本附件按 Unicode 字符数截断且不切开代理对', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-attachment-unicode-'))
  const key = 'owner-a/.chat_staging/unicode.txt', content = '😀'.repeat(100_001)
  await mkdir(path.dirname(path.join(root, key)), { recursive: true })
  await writeFile(path.join(root, key), content, { mode: 0o600 })
  const row = {
    attach_id: 'attachment-unicode', name: '文字', ext: 'txt', mime: 'text/plain', size: Buffer.byteLength(content),
    storage_key: key, kind: 'text', duration: null, img_width: null, img_height: null, extra: null,
    state: 'attached', message_id: 7,
  }
  try {
    const read = createCurrentMessageAttachmentReader({ pool: poolFor('owner-a', 7, row), storageRoot: root })
    const current = await read('owner-a', '7', [{ attach_id: 'attachment-unicode' }])
    const text = await current.readText(current.attachments[0]!)
    assert.equal([...text].filter(char => char === '😀').length, 100_001)
    assert.ok(!text.includes('\uFFFD'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('当前消息 DOCX 正文只在 owner 与 claim 匹配后交给格式提取器', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-docx-'))
  const owner = 'owner-a', key = `${owner}/.chat_staging/current.docx`
  const bytes = Buffer.from('synthetic docx package')
  await mkdir(path.dirname(path.join(root, key)), { recursive: true })
  await writeFile(path.join(root, key), bytes, { mode: 0o600 })
  const row = {
    attach_id: 'attachment-docx', name: '报告', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: bytes.byteLength, storage_key: key, kind: 'text', duration: null, img_width: null, img_height: null, extra: null,
    state: 'attached', message_id: 7,
  }
  const pool = poolFor(owner, 7, row)
  let extracted: Uint8Array | null = null
  try {
    const read = createCurrentMessageAttachmentReader({
      pool,
      storageRoot: root,
      async extractDocumentText(input, extension) {
        assert.equal(extension, 'docx')
        extracted = input
        return '报告正文\n甲\t乙'
      },
    })
    const current = await read(owner, '7', [{ attach_id: 'attachment-docx' }])
    assert.equal(await current.readText(current.attachments[0]!), '报告正文\n甲\t乙')
    assert.deepEqual(extracted, bytes)

    const otherOwner = await read('owner-b', '7', [{ attach_id: 'attachment-docx' }])
    assert.deepEqual(otherOwner.attachments, [])
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

test('当前消息物化器把提取后的 Office 正文放入本轮模型输入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-current-office-message-'))
  const owner = 'owner-a', key = `${owner}/.chat_staging/report.docx`
  const bytes = Buffer.from('synthetic docx package')
  await mkdir(path.dirname(path.join(root, key)), { recursive: true })
  await writeFile(path.join(root, key), bytes, { mode: 0o600 })
  const card = { attach_id: 'attachment-office', name: '报告', ext: 'docx', size_bytes: bytes.byteLength, kind: 'text', upload: true }
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM conversation_messages')) return { rows: [{
        content: '请总结附件', content_json: null, files: [card], references_json: null,
      }] }
      if (sql.includes('FROM chat_attachments')) return { rows: [{
        ...card, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: bytes.byteLength, storage_key: key, state: 'attached', message_id: 9,
        duration: null, img_width: null, img_height: null, extra: null,
      }] }
      throw new Error('unexpected query')
    },
  } as unknown as Pick<Pool, 'query'>
  try {
    const materialize = createWebCurrentMessageMaterializer(pool, {
      storageRoot: root,
      async extractDocumentText(input, extension) {
        assert.deepEqual(input, bytes)
        assert.equal(extension, 'docx')
        return '季度经营收入增加'
      },
    })
    const result = await materialize({ ownerId: owner, sessionId: '2', runId: 'run-office' }, {
      id: '9', content: 'caller supplied content is ignored', contentJson: null, files: [card], references: null,
    })
    assert.match(result.currentUser?.rawText ?? '', /季度经营收入增加/)
    assert.equal(result.currentUser?.message.content, result.currentUser?.rawText)
  } finally { await rm(root, { recursive: true, force: true }) }
})
