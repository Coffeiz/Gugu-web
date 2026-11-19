import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool } from 'pg'
import { createChatAttachmentDraftDeleter } from '@gugu/core/agent/attachments/delete-draft'
import { createPostgresChatAttachmentDraftDeletePorts } from '../../src/modules/agent/attachments/persistence.js'

const owner = '11111111-1111-4111-8111-111111111111'
const key = `${owner}/.chat_staging/attachment.txt`

function database(state: string, referenced = false) {
  const calls: string[] = []
  const query = async (sql: string) => {
    calls.push(sql)
    if (sql.includes('SELECT state,storage_key')) return { rows: [{ state, storage_key: key }], rowCount: 1 }
    if (sql.includes('SELECT 1 FROM chat_attachments')) return { rows: referenced ? [{ '?column?': 1 }] : [], rowCount: referenced ? 1 : 0 }
    if (sql.startsWith('DELETE FROM chat_attachments')) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: null }
  }
  const pool = { async connect() { return { query, release() {} } } } as unknown as Pick<Pool, 'connect'>
  return { pool, calls }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-attachment-delete-'))
  const storage = path.join(root, 'storage')
  const file = path.join(storage, ...key.split('/'))
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, 'synthetic bytes', { mode: 0o600 })
  return { root, storage, file }
}

test('删除 draft 后以共享 storage_key 锁复核引用并清理 Local 字节', async () => {
  const paths = await setup()
  const db = database('draft')
  try {
    const remove = createChatAttachmentDraftDeleter(createPostgresChatAttachmentDraftDeletePorts(db.pool, paths.storage))
    assert.deepEqual(await remove(owner, 'attachment'), { deleted: true })
    await assert.rejects(readFile(paths.file), { code: 'ENOENT' })
    assert.ok(db.calls.some(sql => sql.includes('FOR UPDATE')))
    assert.ok(db.calls.some(sql => sql.includes('pg_advisory_xact_lock')))
    assert.ok(db.calls.includes('COMMIT'))
  } finally { await rm(paths.root, { recursive: true, force: true }) }
})

test('已 attached 的消息附件返回冲突且保留物理字节', async () => {
  const paths = await setup()
  const db = database('attached')
  try {
    const remove = createChatAttachmentDraftDeleter(createPostgresChatAttachmentDraftDeletePorts(db.pool, paths.storage))
    await assert.rejects(remove(owner, 'attachment'), { code: 'conflict' })
    assert.equal(await readFile(paths.file, 'utf8'), 'synthetic bytes')
    assert.ok(!db.calls.some(sql => sql.startsWith('DELETE FROM chat_attachments')))
  } finally { await rm(paths.root, { recursive: true, force: true }) }
})

test('其他附件仍引用相同 storage_key 时跳过物理清理', async () => {
  const paths = await setup()
  const db = database('draft', true)
  try {
    const remove = createChatAttachmentDraftDeleter(createPostgresChatAttachmentDraftDeletePorts(db.pool, paths.storage))
    await remove(owner, 'attachment')
    assert.equal(await readFile(paths.file, 'utf8'), 'synthetic bytes')
  } finally { await rm(paths.root, { recursive: true, force: true }) }
})

test('批量清理只按 owner 删除 draft 行并在事务提交后返回去重输入', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = { async query(sql: string, values?: unknown[]) {
    calls.push({ sql, values })
    if (sql.includes('DELETE FROM chat_attachments') && sql.includes('RETURNING storage_key'))
      return { rows: [{ storage_key: key }, { storage_key: key }, { storage_key: `${owner}/.chat_staging/second.txt` }], rowCount: 3 }
    return { rows: [], rowCount: null }
  }, release() {} }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  const ports = createPostgresChatAttachmentDraftDeletePorts(pool, '/tmp/synthetic-attachment-storage')
  assert.deepEqual(await ports.deleteDraftRows(owner), [key, key, `${owner}/.chat_staging/second.txt`])
  const deletion = calls.find(call => call.sql.includes('DELETE FROM chat_attachments'))
  assert.ok(deletion?.sql.includes("state='draft'"))
  assert.deepEqual(deletion?.values, [owner])
  assert.ok(calls.some(call => call.sql === 'COMMIT'))
})
