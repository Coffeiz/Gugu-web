import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createPostgresImAttachmentIngress, ImAttachmentIngressError, type ImAttachmentScope } from '../../../src/modules/im/gateway/attachment-ingress.js'

const owner = '00000000-0000-4000-8000-000000000111'
const scope: ImAttachmentScope = { ownerId: owner, botId: '111', platform: 'telegram', chatType: 'group', chatId: 'synthetic-group', platformUserId: '1111' }
const input = { scope, sourcePlatformMessageId: 'synthetic-platform-message', sourceAttachmentIndex: 0,
  name: '合成文件', ext: 'txt', mime: 'text/plain', bytes: Buffer.from('合成私有文件正文') }

/** 只替换PG查询；正式上传/私有路径检查/文件写入/删除补偿均真实执行。 */
function database() {
  const rows = new Map<string, Record<string, any>>()
  let authorized = true, failMetadata = false, active = 0, maximum = 0
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM user_bots b')) return { rows: authorized && args[0] === scope.botId && args[1] === owner ? [{ id: 111 }] : [] }
    if (sql.includes('COALESCE(SUM(size)')) return { rows: [{ used: [...rows.values()].reduce((sum, row) => sum + row.size, 0) }] }
    if (sql.startsWith('SELECT attach_id,extra')) return { rows: [...rows.values()].filter(row => row.user_id === args[0] && row.extra?.im_ingress_source === args[1]) }
    if (sql.startsWith('INSERT INTO chat_attachments')) {
      const [id, user, storage, name, ext, mime, kind, size, duration, width, height] = args
      rows.set(String(id), { attach_id: id, user_id: user, storage_key: storage, name, ext, mime, kind, size, duration, img_width: width, img_height: height,
        state: 'draft', message_id: null, extra: null })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE chat_attachments SET platform')) {
      if (failMetadata) throw new Error('合成私有SQL错误')
      const row = rows.get(String(args[1]))!
      row.platform = args[2]; row.platform_message_id = args[3]; row.attachment_index = args[4]; row.extra = JSON.parse(String(args[5]))
      return { rows: [{ attach_id: row.attach_id }] }
    }
    if (sql.startsWith('SELECT state,storage_key')) {
      const row = rows.get(String(args[1])); return { rows: row?.user_id === args[0] ? [row] : [] }
    }
    if (sql.startsWith('DELETE FROM chat_attachments')) {
      const row = rows.get(String(args[1]))
      const allowed = !!row && row.user_id === args[0] && row.state === 'draft'
        && (args.length < 3 || row.extra?.im_ingress_receipt === args[2] && row.extra?.im_ingress_scope === args[3])
      if (allowed) { rows.delete(row!.attach_id); return { rows: [{ storage_key: row!.storage_key }], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('SELECT 1 FROM chat_attachments')) return { rows: [...rows.values()].filter(row => row.user_id === args[0] && row.storage_key === args[1]), rowCount: [...rows.values()].filter(row => row.storage_key === args[1]).length }
    return { rows: [], rowCount: 0 }
  }
  const pool = { query, async connect() {
    active++; maximum = Math.max(maximum, active)
    return { query, release() { active-- } } as unknown as PoolClient
  } } as unknown as Pick<Pool, 'query' | 'connect'>
  return { pool, rows, revoke() { authorized = false }, fail() { failMetadata = true }, get maximum() { return maximum } }
}

test('真实正式upload落本地私有字节，源重复复用且不嵌套占用第二连接，精确receipt才能释放', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-im-stage-')), db = database()
  const storage = createPostgresImAttachmentIngress({ pool: db.pool, storageRoot: root, tempDirectory: root, supportedPlatforms: () => ['telegram'] })
  try {
    const staged = await storage.stage(input), row = db.rows.get(staged.attachId)!
    assert.equal(staged.created, true); assert.ok(staged.creationReceipt)
    assert.deepEqual(await readFile(path.join(root, row.storage_key)), input.bytes)
    assert.equal(row.platform, 'telegram'); assert.equal(row.extra.quoted, false)
    const duplicate = await storage.stage(input)
    assert.deepEqual(duplicate, { ownerId: owner, attachId: staged.attachId, created: false })
    assert.equal(db.maximum, 1)
    await assert.rejects(storage.stage({ ...input, bytes: Buffer.from('不同的同源正文') }), ImAttachmentIngressError)
    await storage.release({ scope, attachId: staged.attachId, creationReceipt: 'not-the-creation-receipt' })
    assert.equal(db.rows.size, 1)
    await storage.release({ scope, attachId: staged.attachId, creationReceipt: staged.creationReceipt! })
    assert.equal(db.rows.size, 0)
    await assert.rejects(readFile(path.join(root, row.storage_key)), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('IM元数据失败仅补偿本次draft与文件，权限拒绝和取消不写磁盘，错误静态脱敏', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-im-stage-failure-')), db = database()
  const storage = createPostgresImAttachmentIngress({ pool: db.pool, storageRoot: root, tempDirectory: root, supportedPlatforms: () => ['telegram'] })
  try {
    db.fail()
    await assert.rejects(storage.stage(input), error => error instanceof ImAttachmentIngressError && !('cause' in error))
    assert.equal(db.rows.size, 0)
    assert.deepEqual(await readdir(path.join(root, owner, '.chat_staging')), [])
    db.revoke()
    await assert.rejects(storage.stage(input), ImAttachmentIngressError)
    const cancel = new AbortController(); cancel.abort(new Error('合成隐私取消正文'))
    await assert.rejects(storage.stage(input, cancel.signal), ImAttachmentIngressError)
    await assert.rejects(storage.stage({ ...input, name: '../合成文件' }), ImAttachmentIngressError)
  } finally { await rm(root, { recursive: true, force: true }) }
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG+真实FS：并发源去重、同消息claim、跨群/跨owner拒绝、quote克隆共享字节及精确释放', {
  skip: !pgUrl && '未运行：需显式GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不证明PG事务/锁/引用生命周期',
}, async () => {
  const { Pool } = await import('pg')
  const schema = `im_attachments_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: pgUrl })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-im-stage-pg-'))
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 1 })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean);
      CREATE TABLE chat_attachments(attach_id text PRIMARY KEY,user_id uuid,message_id integer,storage_key text,platform text,platform_message_id text,
        attachment_index integer,name text,ext text,mime text,kind text,size bigint,duration double precision,img_width integer,img_height integer,state text,extra jsonb,
        created_at timestamptz,attached_at timestamptz)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [owner])
    await pool.query("INSERT INTO user_bots VALUES(111,$1,'telegram',true,true,NULL)", [owner])
    const database = pool
    const storage = createPostgresImAttachmentIngress({ pool: database, storageRoot: root, tempDirectory: root, supportedPlatforms: () => ['telegram'] })
    const values = await Promise.all([storage.stage(input), storage.stage(input)])
    assert.equal(new Set(values.map(item => item.attachId)).size, 1)
    assert.equal(values.filter(item => item.created).length, 1)
    const id = values[0]!.attachId
    const ports = storage.conversation(scope)
    assert.equal(ports.mode, 'enabled')
    if (ports.mode !== 'enabled') throw new Error('附件模式无效')
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      assert.equal((await ports.resolve(client, owner, [id]))[0]!.attach_id, id)
      await ports.claim(client, owner, 11, [id])
      await client.query('COMMIT')
    } finally { client.release() }
    const quoted = await storage.reuse({ scope, sourcePlatformMessageId: input.sourcePlatformMessageId, sourceAttachmentIndex: 0, targetPlatformMessageId: 'synthetic-reply' })
    assert.ok(quoted?.created)
    const rows = (await database.query('SELECT attach_id,storage_key,state,extra FROM chat_attachments ORDER BY attach_id')).rows
    assert.equal(rows.length, 2); assert.equal(rows[0].storage_key, rows[1].storage_key)
    assert.equal(await storage.reuse({ scope: { ...scope, chatId: 'other-group' }, sourcePlatformMessageId: input.sourcePlatformMessageId, sourceAttachmentIndex: 0, targetPlatformMessageId: 'synthetic-reply' }), null)
    await assert.rejects(storage.stage({ ...input, scope: { ...scope, ownerId: randomUUID() } }), ImAttachmentIngressError)
    await storage.release({ scope, attachId: quoted!.attachId, creationReceipt: quoted!.creationReceipt! })
    assert.deepEqual(await readFile(path.join(root, rows[0].storage_key)), input.bytes)
    await storage.release({ scope, attachId: id, creationReceipt: values.find(item => item.created)!.creationReceipt! })
    assert.equal((await database.query('SELECT count(*)::integer AS n FROM chat_attachments')).rows[0].n, 1)
  } finally {
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
