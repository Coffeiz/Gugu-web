import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool, PoolClient } from 'pg'
import { createPostgresAgentAttachmentUploadOperations } from '../../src/modules/agent/attachment-staging-postgres.js'

function database(options: { used?: number; failInsert?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('COALESCE(SUM(size)')) return { rows: [{ used: options.used ?? 0 }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO chat_attachments') && options.failInsert) throw new Error('synthetic insert failure')
    return { rows: [], rowCount: 1 }
  }
  const client = { query, release() {} }
  const pool = { query, async connect() { return client } } as unknown as Pick<Pool, 'query' | 'connect'>
  return { pool, calls }
}

test('草稿持久化以 owner 和受控 key 写入 Local 文件并在事务提交后返回 Python DTO', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-attachment-stage-'))
  const source = path.join(root, 'source')
  const storage = path.join(root, 'storage')
  const body = Buffer.from('%PDF-synthetic-body')
  await writeFile(source, body, { mode: 0o600 })
  const db = database()
  try {
    const operations = createPostgresAgentAttachmentUploadOperations(db.pool, storage)
    const result = await operations.stage('11111111-1111-4111-8111-111111111111', {
      path: source, name: '参考资料', ext: 'PDF', mime: 'application/pdf', size: body.length, voice: false,
    })
    assert.deepEqual(result, { attach_id: result.attach_id, name: '参考资料', ext: 'pdf', size: body.length, kind: 'text', duration: null, img_width: null, img_height: null, qq_face: null })
    const insert = db.calls.find(call => call.sql.startsWith('INSERT INTO chat_attachments'))
    assert.ok(insert)
    assert.equal(insert.values?.[1], '11111111-1111-4111-8111-111111111111')
    assert.equal(insert.values?.[3], '参考资料')
    assert.equal(insert.values?.[4], 'pdf')
    assert.equal(insert.values?.[6], 'text')
    assert.ok(db.calls.some(call => call.sql === 'COMMIT'))
    assert.ok(db.calls.some(call => call.sql.includes('pg_advisory_xact_lock')))
    const storageKey = String(insert.values?.[2])
    assert.equal(await readFile(path.join(storage, ...storageKey.split('/'))).then(value => value.toString()), body.toString())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('草稿记录提交失败时回滚数据库并删除刚写入的孤儿字节', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-attachment-rollback-'))
  const source = path.join(root, 'source')
  const storage = path.join(root, 'storage')
  await writeFile(source, 'text-body', { mode: 0o600 })
  const db = database({ failInsert: true })
  try {
    const operations = createPostgresAgentAttachmentUploadOperations(db.pool, storage)
    await assert.rejects(operations.stage('11111111-1111-4111-8111-111111111111', {
      path: source, name: '草稿', ext: 'txt', mime: 'text/plain', size: 9, voice: false,
    }), /synthetic insert failure/)
    assert.ok(db.calls.some(call => call.sql === 'ROLLBACK'))
    const directory = path.join(storage, '11111111-1111-4111-8111-111111111111', '.chat_staging')
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同一 owner 连续上传时复用已创建的私有暂存目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-attachment-reuse-'))
  const source = path.join(root, 'source')
  const storage = path.join(root, 'storage')
  await writeFile(source, 'text-body', { mode: 0o600 })
  try {
    const operations = createPostgresAgentAttachmentUploadOperations(database().pool, storage)
    const owner = '11111111-1111-4111-8111-111111111111'
    await operations.stage(owner, { path: source, name: '第一份', ext: 'txt', mime: 'text/plain', size: 9, voice: false })
    await operations.stage(owner, { path: source, name: '第二份', ext: 'txt', mime: 'text/plain', size: 9, voice: false })
    const directory = path.join(storage, owner, '.chat_staging')
    assert.equal((await readdir(directory)).length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
