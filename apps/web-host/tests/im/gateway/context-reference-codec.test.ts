import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { assertDurableCanonical, type CanonicalMessage, type MessageEntry } from '@gugu/core/agent'
import { createImContextReferenceCodec, ImContextReferenceError } from '../../../src/modules/im/gateway/agent/references.js'
import { createImMessageMaterializer } from '../../../src/modules/im/gateway/inbound/message.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../../../src/modules/im/gateway/inbound/attachments.js'

const owner = '00000000-0000-4000-8000-000000000091'
const identity = { ownerId: owner, sessionId: '91', runId: 'synthetic-run' }
const scope: ImAttachmentScope = { ownerId: owner, botId: '91', platform: 'telegram', chatType: 'group', chatId: 'synthetic-group', platformUserId: 'synthetic-speaker' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvL8AAAAASUVORK5CYII=', 'base64')
const entry = (message: CanonicalMessage): MessageEntry => ({ entryId: 'synthetic-entry', sequence: 1, revision: 0,
  source: 'attachment', persistencePolicy: 'already_persisted', message })
const attachment = () => ({ attach_id: 'synthetic-attachment', name: '合成图片', ext: 'png', mime: 'image/png', kind: 'image',
  size: png.length, storage_key: `${owner}/.chat_staging/synthetic.png`, platform: 'telegram', state: 'attached',
  extra: { im_ingress_scope: imAttachmentScopeKey(scope) }, message_id: 11, duration: null })
const ref = () => ({ type: 'attachment_ref', attach_id: 'synthetic-attachment', name: '合成图片', ext: 'png', mime: 'image/png', kind: 'image', size_bytes: png.length })
const failure = (error: unknown) => {
  assert.ok(error instanceof ImContextReferenceError)
  assert.equal(error.message, 'IM 上下文引用不可用'); assert.equal(error.cause, undefined)
  return true
}
function fixture() {
  let allowed = true, session = true, afterQuery: (() => void) | undefined
  const rows = [attachment()], calls: { sql: string; args: unknown[] }[] = []
  // PG查询协议替身：真实SQL归属边界另由下方opt-in隔离PG验证。
  const pool = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args })
    let selected: unknown[]
    if (sql.startsWith('SELECT 1 FROM conversation_sessions')) selected = session ? [{}] : []
    else if (sql.includes('FROM gugu_im_inbound_receipts') || sql.includes('JOIN gugu_im_inbound_receipts')) selected = [{ id: '11', content: '合成正文', content_json: null,
      files: [ref()], quoted_text: null, platform_user_id: scope.platformUserId, platform_user_name: '合成成员', message_ms: '1700000000000' }]
    else if (sql.includes('FROM chat_attachments WHERE')) selected = rows
    else if (sql.includes('FROM chat_attachments a')) selected = rows.filter(row => typeof args[2] === 'string' ? row.attach_id === args[2] : (args[2] as string[]).includes(row.attach_id))
    else throw new Error('synthetic-private-sql')
    afterQuery?.(); return { rows: selected, rowCount: selected.length }
  } } as unknown as Pick<Pool, 'query'>
  const options = { pool, identity, scope, authorize: async () => allowed }
  return { options, calls, rows, revoke() { allowed = false }, noSession() { session = false }, afterQuery(callback: () => void) { afterQuery = callback } }
}

test('稳定引用真实查询Run收据及附件归属，文本和工具结果元数据不被改写', async () => {
  const f = fixture(), codec = createImContextReferenceCodec(f.options)
  const message: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: '合成正文' }, ref()], _history_id: '11' }
  const durable = await codec.dehydrate(entry(message), identity)
  assert.deepEqual(durable, message); assert.notEqual(durable, message)
  assert.deepEqual(await codec.hydrate(entry(durable), identity), message)
  const result: CanonicalMessage = { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'synthetic-call', content: JSON.stringify({ file: ref() }) }] }
  assert.deepEqual(await codec.dehydrate(entry(result), identity), result)
  assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT 1')).length, 3)
  assert.equal(f.calls.every(call => call.args[0] === owner && call.args[1] === identity.sessionId), true)
})

test('跨owner/session/run、无该Run收据、撤销或读后撤权均失败关闭', async () => {
  const f = fixture(), codec = createImContextReferenceCodec(f.options), message = entry({ role: 'user', content: '合成正文' })
  for (const target of [{ ...identity, ownerId: 'another-owner' }, { ...identity, sessionId: '92' }, { ...identity, runId: 'another-run' }])
    await assert.rejects(codec.hydrate(message, target), failure)
  assert.equal(f.calls.length, 0)
  f.noSession(); await assert.rejects(codec.dehydrate(message, identity), failure)
  const revoked = fixture(), revokingCodec = createImContextReferenceCodec(revoked.options)
  revoked.afterQuery(() => revoked.revoke())
  await assert.rejects(revokingCodec.hydrate(message, identity), failure)
})

test('伪造群/Bot附件scope、未claim附件、其他owner路径和虚假媒体字段不被接受', async () => {
  for (const mutate of [(row: ReturnType<typeof attachment>) => { row.extra.im_ingress_scope = 'another-scope' },
    (row: ReturnType<typeof attachment>) => { row.state = 'draft' },
    (row: ReturnType<typeof attachment>) => { row.platform = 'qq' },
    (row: ReturnType<typeof attachment>) => { row.storage_key = '00000000-0000-4000-8000-000000000092/private.png' },
    (row: ReturnType<typeof attachment>) => { row.mime = 'application/octet-stream' }]) {
    const f = fixture(); mutate(f.rows[0]!)
    await assert.rejects(createImContextReferenceCodec(f.options).hydrate(entry({ role: 'user', content: [ref()] }), identity), failure)
  }
  const absent = fixture(); absent.rows.length = 0
  await assert.rejects(createImContextReferenceCodec(absent.options).hydrate(entry({ role: 'user', content: [ref()] }), identity), failure)
})

test('临时URL、inline媒体和推理材料不能借引用端口进入checkpoint，普通正文不误判', async () => {
  const f = fixture(), codec = createImContextReferenceCodec(f.options)
  for (const content of [[{ type: 'image', source: { type: 'base64', data: 'synthetic-private' } }],
    [{ type: 'file', url: 'https://example.test/a?token=synthetic-private' }],
    [{ type: 'thinking', text: 'synthetic-private' }],
    [{ type: 'tool_result', tool_call_id: 'a', content: JSON.stringify({ signed_url: 'https://example.test/synthetic-private' }) }]])
    await assert.rejects(codec.dehydrate(entry({ role: 'user', content }), identity), failure)
  const ordinary = { role: 'user', content: '讨论JSON {"type":"image"} 及 URL https://example.test/?token=synthetic-placeholder' }
  assert.deepEqual(await codec.dehydrate(entry(ordinary), identity), ordinary)
  const cancelled = new AbortController(); cancelled.abort(new Error('synthetic-private-cancel'))
  await assert.rejects(codec.hydrate(entry(ordinary), identity, cancelled.signal), failure)
  const broken = createImContextReferenceCodec({ ...f.options, pool: { async query() { throw new Error('synthetic-private-database') } } as unknown as Pick<Pool, 'query'> })
  await assert.rejects(broken.hydrate(entry(ordinary), identity), failure)
})

test('真实materializer+正式codec：本地PNG进入Canonical，持久引用无字节，重建重新读取并拒绝失踪文件', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'gugu-im-reference-'))
  try {
    const file = join(directory, f.rows[0]!.storage_key)
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, png)
    const materializer = createImMessageMaterializer({ ...f.options, storageRoot: directory, messageIds: ['11'], timezone: 'UTC', formatMessageTime: () => '合成时间' })
    const current = await materializer.materialize(identity, { id: '11', content: '', contentJson: null, files: [], references: [] })
    const codec = materializer.references(createImContextReferenceCodec(f.options))
    const durable = await codec.dehydrate(entry(current.currentUser!.message), identity)
    assertDurableCanonical(durable)
    assert.doesNotMatch(JSON.stringify(durable), new RegExp(png.toString('base64').slice(0, 16)))
    assert.match(JSON.stringify(await codec.hydrate(entry(durable), identity)), new RegExp(png.toString('base64').slice(0, 16)))
    await rm(file)
    await assert.rejects(codec.hydrate(entry(durable), identity), { message: 'IM 消息上下文无法恢复' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG正式SQL：当前Run、群和Bot收据与附件scope同时成立才可恢复', {
  skip: !pgUrl && '未运行：需显式GUGU_IM_GATEWAY_TEST_DATABASE_URL；查询替身不代表真实PG归属验收',
}, async () => {
  const { Pool } = await import('pg'), schema = `im_reference_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl }); let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 1 })
    await pool.query(`CREATE TABLE conversation_sessions(id integer,user_id uuid,chat_id text,source text,bot_id text,chat_type text);
      CREATE TABLE conversation_messages(id integer,session_id integer,run_id text,chat_type text,platform_user_id text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,state text,platform text,bot_id text,chat_type text);
      CREATE TABLE chat_attachments(attach_id text,user_id uuid,message_id integer,name text,kind text,ext text,mime text,size bigint,storage_key text,platform text,state text,extra jsonb)`)
    await pool.query("INSERT INTO conversation_sessions VALUES(91,$1,$2,'telegram','91','group')", [owner, scope.chatId])
    await pool.query("INSERT INTO conversation_messages VALUES(11,91,$1,'group',$2)", [identity.runId, scope.platformUserId])
    await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,91,11,$2,'dispatched','telegram','91','group')", [owner, identity.runId])
    const a = attachment()
    await pool.query('INSERT INTO chat_attachments VALUES($1,$2,11,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [a.attach_id, owner, a.name, a.kind, a.ext, a.mime, a.size, a.storage_key, a.platform, a.state, a.extra])
    const message = entry({ role: 'user', content: [ref()] })
    const create = (patch: Partial<ImAttachmentScope> = {}) => createImContextReferenceCodec({ pool: pool!, identity, scope: { ...scope, ...patch }, authorize: async () => true })
    assert.deepEqual(await create().hydrate(message, identity), message.message)
    for (const patch of [{ botId: '92' }, { chatId: 'another-group' }, { platform: 'qq' as const }, { chatType: 'c2c' as const, chatId: null }])
      await assert.rejects(create(patch).hydrate(message, identity), failure)
    // 即使旧收据存在，后来被错误改绑的会话也不能借旧Run读回群内容。
    for (const update of ["bot_id='92'", "source='qq'", "chat_type='c2c'"]) {
      await pool.query(`UPDATE conversation_sessions SET ${update}`)
      await assert.rejects(create().hydrate(message, identity), failure)
      await pool.query("UPDATE conversation_sessions SET bot_id='91',source='telegram',chat_type='group'")
    }
    await pool.query("UPDATE chat_attachments SET extra='{}'::jsonb")
    await assert.rejects(create().hydrate(message, identity), failure)
    await pool.query('UPDATE chat_attachments SET extra=$1', [a.extra])
    await pool.query("UPDATE gugu_im_inbound_receipts SET run_id='another-run'")
    await assert.rejects(create().hydrate(message, identity), failure)
    const privateScope = { ...scope, chatType: 'c2c' as const, chatId: null }
    await pool.query("UPDATE conversation_sessions SET source='web',bot_id=NULL,chat_type=NULL,chat_id=NULL")
    await pool.query("UPDATE conversation_messages SET chat_type='c2c'")
    await pool.query("UPDATE gugu_im_inbound_receipts SET run_id=$1,chat_type='c2c'", [identity.runId])
    await pool.query('UPDATE chat_attachments SET extra=$1', [{ im_ingress_scope: imAttachmentScopeKey(privateScope) }])
    assert.deepEqual(await create({ chatType: 'c2c', chatId: null }).hydrate(message, identity), message.message)
    await assert.rejects(create({ chatType: 'c2c', chatId: null, platformUserId: 'another-speaker' }).hydrate(message, identity), failure)
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
})
