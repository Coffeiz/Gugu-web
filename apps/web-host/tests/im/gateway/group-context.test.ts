import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { ImActor } from '@gugu/core/im/access'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { GroupContextSearchRequest } from '@gugu/core/tools'
import { createPostgresImGroupContextSearch, ImGroupContextError } from '../../../src/modules/im/gateway/group-context.js'
import { imMemoryMaintenanceScopeFileKey } from '../../../src/modules/admin/memory-apply.js'
import { createAgentToolRegistry } from '../../../src/modules/agent-sessions/tools/agent-tool-registry.js'

const owner = '00000000-0000-4000-8000-000000000097'
const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-run' }
const actor: ImActor = { ownerId: owner, botId: '97', platform: 'qq', chatType: 'group', chatId: 'synthetic-room', platformUserId: 'speaker',
  role: 'member', verifiedOwner: false, ownerMentionAuthorized: false, allowedToolNames: ['group_context_search'], speakerRoles: null }
const signal = () => new AbortController().signal
const request = (patch: Partial<GroupContextSearchRequest> = {}): GroupContextSearchRequest => ({ keyword: '', queries: [], mode: 'OR', speaker: '', limit: 10, ...patch })
async function fixture(work: (root: string, write: (value: unknown, group?: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-group-context-'))
  try { await work(root, async (value, group = actor.chatId!) => {
    const path = join(root, imMemoryMaintenanceScopeFileKey({ owner_user_id: owner, platform: 'qq', bot_id: '97', scope_type: 'group', scope_id: group }, 'members.json'))
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
  }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('Hostregistry缺少真实群端口不注册，装配后真实派发且撤权拒绝', async () => {
  let allowed = true, calls = 0
  const options = { core: {} as SqlDataRuntime, authorize: async () => allowed }
  const missing = createAgentToolRegistry(options)
  assert.equal((await missing.capabilities(identity)).some(item => item.name === 'group_context_search'), false)
  const registry = createAgentToolRegistry({ ...options, groupContext: { async search() { calls++; return { messages: [] } } } })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'group_context_search'), true)
  const scope = { identity, roundId: 'round', signal: signal(), resolution: null, execute: async () => { throw Error('不应执行副作用') } }
  assert.equal((await registry.tools.dispatch({ id: 'call', name: 'group_context_search', input: {} }, scope)).kind, 'completed')
  allowed = false
  const revoked = await registry.tools.dispatch({ id: 'call2', name: 'group_context_search', input: {} }, scope)
  assert.equal(revoked.kind, 'completed')
  if (revoked.kind === 'completed') assert.equal(revoked.executed, false)
  assert.equal(calls, 1)
})

test('私聊/微信/跨Run构造或调用拒绝，授权必须先于数据库和members读取', async () => fixture(async root => {
  let calls = 0
  const options = { pool: { async query() { calls++; return { rows: [] } } }, storageRoot: root, identity, actor, beforeMessageId: 99, authorize: async () => false, isTombstoned: async () => false }
  for (const invalid of [{ ...actor, chatType: 'c2c' as const, chatId: null }, { ...actor, platform: 'wechat' as const }])
    assert.throws(() => createPostgresImGroupContextSearch({ ...options, actor: invalid }), ImGroupContextError)
  const port = createPostgresImGroupContextSearch(options)
  await assert.rejects(port.search(identity, request({ speaker: '小北' }), signal()), { code: 'unauthorized' })
  await assert.rejects(port.search({ ...identity, runId: 'other-run' }, request(), signal()), { code: 'unauthorized' })
  assert.equal(calls, 0)
}))

test('真实members文件仅当前scope，精确alias优先且读取后撤权不返回候选或内容', async () => fixture(async (root, write) => {
  await write({ members: { first: { aliases: ['小北'], last_seen_at: 20 } } })
  await write({ members: { foreign: { aliases: ['小北'], last_seen_at: 99 } } }, 'another-room')
  let checks = 0, queries = 0
  const rows = [{ id: 1, session_id: 1, anchor_id: 99, role: 'user', content: '合成消息', content_json: null, platform_user_id: 'second', platform_user_name: '小北哥', created_at: new Date(1000) }]
  const port = createPostgresImGroupContextSearch({ pool: { async query(_sql, values) {
    queries++
    if (values.length > 7) { assert.equal(values[7], 'first'); return { rows: [{ ...rows[0], platform_user_id: 'first' }] } }
    return { rows }
  } }, storageRoot: root, identity, actor, beforeMessageId: 99, authorize: async () => ++checks < 2, isTombstoned: async () => false })
  await assert.rejects(port.search(identity, request({ speaker: '小北' }), signal()), { code: 'unauthorized' })
  assert.equal(queries, 2)
}))

test('members损坏/超大与数据库错误公开静态错误，真实pid命中不读损坏文件', async () => fixture(async (root, write) => {
  const rows = [{ id: 1, session_id: 1, anchor_id: 99, role: 'user', content: '内容', content_json: null, platform_user_id: 'pid', platform_user_name: '小北', created_at: new Date() }]
  const options = { pool: { async query() { return { rows } } }, storageRoot: root, identity, actor, beforeMessageId: 99, authorize: async () => true, isTombstoned: async () => false }
  await write('{broken synthetic-secret')
  const port = createPostgresImGroupContextSearch(options)
  assert.equal((await port.search(identity, request({ speaker: 'pid' }), signal())).speaker_id, 'pid')
  await assert.rejects(port.search(identity, request({ speaker: '小北' }), signal()), { code: 'invalid_data', message: '当前群上下文读取不可用' })
  await write('x'.repeat(2 * 1024 * 1024 + 1))
  await assert.rejects(port.search(identity, request({ speaker: '小北' }), signal()), { message: '当前群上下文读取不可用' })
  await write({ members: { silent: { name: null, aliases: null, nicknames: null, last_seen_at: null } } })
  assert.equal((await port.search(identity, request({ speaker: 'silent' }), signal())).speaker_id, 'silent', '真实聚合允许没有时间或昵称的沉默成员')
  const failing = createPostgresImGroupContextSearch({ ...options, pool: { async query() { throw Error('synthetic-secret SQL') } } })
  await assert.rejects(failing.search(identity, request(), signal()), error => error instanceof ImGroupContextError && !String(error).includes('synthetic-secret') && error.cause === undefined)
}))

const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('真实PG当前群/成员/Run水位隔离，ILIKE与留存边界不被2000硬截缩小', { skip: !url && '需显式隔离PG；查询替身不能验证SQL隔离与排序', timeout: 30000 }, async () => fixture(async (root, write) => {
  const { Pool } = await import('pg')
  const schema = `im_group_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  let allowed = true
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,conversation_seq bigint,role text,content text,content_json jsonb,platform_user_id text,platform_user_name text,created_at timestamptz,run_id text);`)
    const owners = [owner, '00000000-0000-4000-8000-000000000098']
    await pool.query(`INSERT INTO users VALUES($1,true,'active'),($2,true,'active')`, owners)
    await pool.query(`INSERT INTO user_bots VALUES(97,$1,'qq',true),(98,$1,'qq',true),(99,$2,'qq',true)`, owners)
    await pool.query(`INSERT INTO conversation_sessions VALUES(1,$1,'qq',97,'group','synthetic-room'),(2,$1,'qq',97,'group','other-room'),
        (3,$1,'qq',98,'group','synthetic-room'),(4,$1,'telegram',97,'group','synthetic-room'),(5,$2,'qq',99,'group','synthetic-room'),(6,$1,'qq',97,'c2c',NULL)`, [owner, '00000000-0000-4000-8000-000000000098'])
    await pool.query(`INSERT INTO conversation_messages SELECT n,1,n,'user',CASE WHEN n=1 THEN '最早未被摘要覆盖的保留消息' ELSE '普通消息' END,NULL,'a','小北',now(),NULL FROM generate_series(1,2002) n`)
    await pool.query(`INSERT INTO conversation_messages VALUES
      (5000,1,2003,'user','部署上线',NULL,'a','小北',now(),NULL),
      (5001,1,2004,'assistant','部署完成',NULL,NULL,NULL,now(),NULL),
      (5002,1,2005,'user','部署明天',NULL,'b','小北哥',now(),NULL),
      (5003,1,2006,'user','JSON隐藏消息','{}','a','小北',now(),NULL),
      (9000,1,2007,'user','当前锚点消息',NULL,'a','小北',now(),'synthetic-run'),
      (3,1,2008,'user','未来消息全局ID更小',NULL,'a','小北',now(),NULL)
      ON CONFLICT(id) DO UPDATE SET conversation_seq=EXCLUDED.conversation_seq,content=EXCLUDED.content`)
    for (let i = 2; i <= 6; i++) await pool.query(`INSERT INTO conversation_messages VALUES($1,$2,1,'user','foreign-private-synthetic',NULL,'a','小北',now(),NULL)`, [10000 + i, i])
    await write({ members: { a: { aliases: ['北神'], last_seen_at: 1 }, b: { nicknames: ['北神'], last_seen_at: 2 } } })
    const make = (patch: Partial<ImActor> = {}, beforeMessageId = 9000) => createPostgresImGroupContextSearch({ pool, storageRoot: root, identity, actor: { ...actor, ...patch }, beforeMessageId,
      authorize: async () => allowed, isTombstoned: async () => false })
    const port = make()
    const recent = await port.search(identity, request({ limit: 3 }), signal())
    assert.deepEqual((recent.messages as any[]).map(value => value.content), ['部署上线', '部署完成', '部署明天'])
    assert.doesNotMatch(JSON.stringify(recent), /foreign-private|未来|当前锚点|JSON隐藏/)
    const and = await port.search(identity, request({ queries: ['部署', '上线'], mode: 'AND' }), signal())
    assert.deepEqual((and.messages as any[]).map(value => value.content), ['部署上线'])
    const speaker = await port.search(identity, request({ speaker: '小北', queries: ['部署'] }), signal())
    assert.equal(speaker.speaker_id, 'a'); assert.deepEqual((speaker.messages as any[]).map(value => value.content), ['部署上线'])
    const ambiguous = await port.search(identity, request({ speaker: '北神' }), signal())
    assert.deepEqual((ambiguous.candidates as any[]).map(value => value.platform_user_id), ['b', 'a'])
    assert.equal((await port.search(identity, request({ queries: ['最早'] }), signal())).messages instanceof Array, true)
    assert.equal(((await port.search(identity, request({ queries: ['最早'] }), signal())).messages as unknown[]).length, 1, '未物理裁剪且>2000的消息必须仍可检索')
    await pool.query('DELETE FROM conversation_messages WHERE id=1')
    assert.deepEqual((await port.search(identity, request({ queries: ['最早'] }), signal())).messages, [], '实际已裁剪消息不能从文件或其他来源复活')
    for (const patch of [{ chatId: 'other-room' }, { botId: '98' }, { platform: 'telegram' as const }, { ownerId: '00000000-0000-4000-8000-000000000098' }]) {
      if (patch.ownerId) assert.throws(() => make(patch), ImGroupContextError)
      else await assert.rejects(make(patch).search(identity, request(), signal()), { code: 'unauthorized' })
    }
    await assert.rejects(make({}, 5000).search(identity, request(), signal()), { code: 'unauthorized' })
    allowed = false; await assert.rejects(port.search(identity, request(), signal()), { code: 'unauthorized' }); allowed = true
    await pool.query('UPDATE user_bots SET enabled=false WHERE id=97')
    await assert.rejects(port.search(identity, request(), signal()), { code: 'unauthorized' })
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
}))
