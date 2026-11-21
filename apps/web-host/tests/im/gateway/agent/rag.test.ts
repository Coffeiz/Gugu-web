import { createSqlMemoryScopeStateReader } from '@gugu/core/agent/rag'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildRunRagContext, prepareContext, stableJson, type ContextSourceSelection, type PersistedHistoryRow, type PreparationPorts } from '@gugu/core/agent'
import { imContextPolicy, type ImActor } from '@gugu/core/im/access'
import type { AgentDispatchLease } from '../../../../src/modules/agent/run/dispatch.js'
import { createPostgresImAccess } from '../../../../src/modules/im/gateway/inbound/access.js'
import { createPostgresImRagContextBuilder } from '../../../../src/modules/im/gateway/agent/rag.js'

const url = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const sha = (value: string) => createHash('sha256').update(value.trim()).digest('hex')
async function fixture(work: (f: {
  pool: import('pg').Pool; root: string; owner: string; actor: ImActor; lease: AgentDispatchLease
  readScope: ReturnType<typeof createSqlMemoryScopeStateReader>
  write(scope: 'group' | 'member' | 'owner', text: string, id?: string): Promise<void>
  build(actor?: ImActor, lease?: AgentDispatchLease, enabled?: () => boolean | Promise<boolean>): Promise<ReturnType<typeof createPostgresImRagContextBuilder>>
  input(patch?: Record<string, unknown>): { ownerId: string; sessionId: string; query: string; history: PersistedHistoryRow[]; beforeMessageId: string; snapshotText: string }
}) => Promise<void>) {
  const { Pool } = await import('pg'), { Kysely, PostgresDialect } = await import('kysely')
  const owner = randomUUID(), schema = `im_rag_${randomUUID().replaceAll('-', '')}`, root = await mkdtemp(join(tmpdir(), 'gugu-im-auto-rag-'))
  const admin = new Pool({ connectionString: url }), pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  const actor: ImActor = { ownerId: owner, botId: '97', platform: 'qq', chatType: 'group', chatId: 'room', platformUserId: 'member-a', role: 'member', verifiedOwner: false, ownerMentionAuthorized: false, allowedToolNames: ['group_context_search'], speakerRoles: null }
  const lease: AgentDispatchLease = { identity: { ownerId: owner, sessionId: '1', runId: 'synthetic-run' }, token: 'synthetic-token', fence: 1, mode: 'start', cancelRequested: false,
    input: { v: 3, source: 'im', userMessageId: 150, origin: null, locale: null, accessVersion: 'a'.repeat(64), im: { platform: 'qq', botId: '97', chatType: 'group', chatId: 'room', platformUserId: 'member-a', batch: { batchKey: 'b'.repeat(64), segmentKey: 'c'.repeat(64), messageIds: [99, 150] } } } }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text,group_allowed_tools json,group_owner_memory_enabled boolean,group_chat_enabled boolean,feishu_group_chat_enabled boolean,group_memory_enabled boolean,member_memory_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id varchar(128),chat_type text,chat_id text,active_run_id text,title text,summary text,baseline_message_seq bigint,updated_at timestamptz);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,content text,conversation_seq bigint,history_anchor_seq bigint,created_at timestamptz,run_id text,platform_user_id text,sent_at timestamptz);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,message_id integer,run_id text,platform text,bot_id text,chat_type text,state text);
      CREATE TABLE memory_reflection_cursors(owner_user_id uuid,platform text,bot_id text,scope_type text,scope_id text,scope_version integer,updated_at timestamptz);
      CREATE TABLE memory_scope_tombstones(owner_user_id uuid,platform text,bot_id text,scope_type text,scope_id text);
      CREATE TABLE knowledge_index_entries(id serial PRIMARY KEY,owner_user_id uuid,indexed_at timestamptz DEFAULT now(),deleted_at timestamptz,source_type text,source_id text,scope_type text,scope_id text,platform text,bot_id text,group_id text,document_id text,parent_document_id text,document_version text,chunk_index integer DEFAULT 0,chunk_count integer DEFAULT 1,title text,summary text,content text,metadata_json jsonb,source_updated_at timestamptz DEFAULT now());`)
    await pool.query(`INSERT INTO users VALUES($1,true,'active')`, [owner])
    await pool.query(`INSERT INTO user_bots VALUES(97,$1,'qq',true,'owner-user','["group_context_search"]',false,true,NULL,true,true)`, [owner])
    await pool.query(`INSERT INTO conversation_sessions VALUES(1,$1,'qq',97,'group','room','synthetic-run','合成群','部署旧摘要',2,'2020-01-01Z'),(2,$1,'qq',97,'group','other',NULL,'其他群','部署其他群',1,'2020-01-01Z')`, [owner])
    await pool.query(`INSERT INTO conversation_messages VALUES(10,1,'user','部署过去事实',1,NULL,'2020-01-01Z',NULL,'member-a'),
      (99,1,'user','部署当前第一锚点',10,NULL,'2021-01-01Z','synthetic-run','member-a'),
      (150,1,'user','部署当前第二锚点',11,NULL,'2021-01-01Z','synthetic-run','member-a'),
      (20,1,'user','部署未来消息',12,NULL,'2022-01-01Z',NULL,'member-a'),(30,2,'user','部署别群事实',1,NULL,'2020-01-01Z',NULL,'member-a')`)
    await pool.query(`INSERT INTO agent_run_dispatch VALUES($1,1,'synthetic-run','selected','synthetic-token',1,clock_timestamp()+interval '1 hour')`, [owner])
    await pool.query(`INSERT INTO gugu_im_inbound_receipts SELECT $1,1,n,'synthetic-run','qq','97','group','dispatched' FROM unnest(ARRAY[99,150]) n`, [owner])
    await pool.query(`INSERT INTO memory_reflection_cursors VALUES($1,'qq','97','group','room',1,now()),($1,'qq','97','platform-user','room:member-a',1,now())`, [owner])
    async function entry(id: string, scope: string, scopeId: string, type: string, content: string, metadata: unknown, group = 'room') {
      await pool.query(`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,title,summary,content,metadata_json)
        VALUES($1,$2,$3,$4,$5,'qq','97',$6,$3,$3,'v1','部署资料','',$7,$8)`, [owner, type, id, scope, scopeId, group, content, metadata])
    }
    await entry('past', 'group', 'room', 'conversation', '部署过去事实', { kind: 'message', session_id: '1', message_id: '10', context_after: '部署当前和未来消息泄露', context_current: '不可信索引正文' })
    await entry('future', 'group', 'room', 'conversation', '部署未来消息', { kind: 'message', session_id: '1', message_id: '20' })
    await entry('foreign', 'group', 'room', 'conversation', '部署伪装别群', { kind: 'message', session_id: '2', message_id: '30' })
    await entry('summary', 'group', 'room', 'conversation', '部署过期summary投影', { kind: 'summary', session_id: '1' })
    await entry('stale', 'group', 'room', 'memory', '部署已删除但索引还在的秘密', {})
    await entry('owner', 'owner', '', 'knowledge', '部署owner独占知识', {})
    await entry('other-member', 'member', 'room:member-b', 'memory', '部署旁人私密索引', {})
    const access = createPostgresImAccess({ query: (statement, parameters) => pool.query(statement, parameters), supportedPlatforms: () => ['qq', 'feishu', 'telegram', 'wechat'] })
    await work({ pool, root, owner, actor, lease, readScope: createSqlMemoryScopeStateReader(db),
      async write(scope, text, id) {
        const key = scope === 'owner' ? `${owner}/.agent/memories/memory.md` : `${owner}/.agent/memories/im/qq/97/${scope === 'group' ? 'groups' : 'platform-users'}/${encodeURIComponent(id ?? (scope === 'group' ? 'room' : 'room:member-a'))}/memory.md`
        const file = join(root, key); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text)
      },
      async build(who = actor, run = lease, enabled = () => true) {
        const bot = await access.readBot(who); assert.ok(bot)
        return createPostgresImRagContextBuilder({ core: { db, backend: 'postgres' }, pool, storageRoot: root, lease: run, actor: who, bot,
          selection: { contextPolicy: imContextPolicy(who, bot, true), contextScopeKey: run.input.accessVersion, modelIdentity: 'synthetic-model' } as Pick<ContextSourceSelection, 'contextPolicy' | 'contextScopeKey' | 'modelIdentity'>,
          access, enabled })
      },
      input(patch = {}) { return { ownerId: owner, sessionId: '1', query: '部署', history: [], beforeMessageId: '99', snapshotText: '', ...patch } },
    })
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }) }
}

test('真实PG/FS自动RAG只召回当前群与当前成员，group关闭时member不隐含group且不回落owner', { skip: !url && '需任务隔离PG及真实索引', timeout: 30000 }, async () => fixture(async f => {
  await f.write('group', '部署本群公开记忆'); await f.write('member', '部署成员自己的私有资料'); await f.write('member', '部署旁人文件私密', 'room:member-b'); await f.write('owner', '部署owner私人记忆')
  const build = await f.build(), result = await build(f.input())
  assert.equal(result.injected, true)
  const text = JSON.stringify(result)
  assert.match(text, /本群公开记忆|部署过去事实|成员自己的私有资料/)
  assert.doesNotMatch(text, /owner独占|owner私人|旁人|别群|未来消息|当前第一锚点|当前第二锚点|已删除|不可信索引/)
  await f.pool.query('UPDATE user_bots SET group_memory_enabled=false')
  const member = await build(f.input())
  assert.equal(member.injected, true); assert.match(JSON.stringify(member), /成员自己的私有资料/)
  assert.doesNotMatch(JSON.stringify(member), /本群|过去事实|旧摘要|owner/)
  await f.pool.query('UPDATE user_bots SET member_memory_enabled=false')
  assert.equal((await build(f.input())).reason, 'no_eligible_scope')
}))

test('最早真实批次锚点与事实seq阻止当前/未来/伪造邻文，summary实际水位和历史hash排除均生效', { skip: !url && '需任务隔离PG', timeout: 30000 }, async () => fixture(async f => {
  const build = await f.build()
  const result = await build(f.input())
  assert.equal(result.injected, true)
  const text = JSON.stringify(result)
  assert.match(text, /部署过去事实|部署旧摘要/)
  assert.doesNotMatch(text, /未来消息|当前和未来|不可信|伪装|过期summary/)
  await f.pool.query("UPDATE conversation_messages SET created_at='2021-01-01 00:00:00.000100+00' WHERE id=99")
  await f.pool.query(`INSERT INTO conversation_sessions VALUES(3,$1,'qq','97','group','room',NULL,'同群旧会话','部署微秒未来摘要',1,'2021-01-01 00:00:00.000900+00')`, [f.owner])
  await f.pool.query("INSERT INTO conversation_messages VALUES(40,3,'user','部署早ID但晚到消息',1,NULL,'2021-01-01 00:00:00.000900+00',NULL,'member-a',NULL)")
  await f.pool.query(`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,title,summary,content,metadata_json)
    VALUES($1,'conversation','later-summary','group','room','qq','97','room','later-summary','later-summary','v1','部署资料','','部署微秒未来摘要','{"kind":"summary","session_id":"3"}'),
      ($1,'conversation','later-message','group','room','qq','97','room','later-message','later-message','v1','部署资料','','部署早ID但晚到消息','{"kind":"message","session_id":"3","message_id":"40"}')`, [f.owner])
  assert.doesNotMatch(JSON.stringify(await build(f.input())), /微秒未来摘要|早ID但晚到消息/, '同毫秒内PG微秒和真实消息时间水位不能被JS Date截断或较小ID绕过')
  await f.pool.query("UPDATE conversation_sessions SET title='部署未来标题',updated_at='2021-01-01 00:00:00.000900+00' WHERE id=1")
  const changedSession = JSON.stringify(await build(f.input()))
  assert.match(changedSession, /部署过去事实/)
  assert.doesNotMatch(changedSession, /部署未来标题|部署旧摘要/, '同session旧baseline不能证明可变summary或title版本早于本Run')
  await f.pool.query("UPDATE conversation_sessions SET title='合成群',updated_at='2020-01-01Z' WHERE id=1")
  assert.equal((await build(f.input({ beforeMessageId: '150' }))).reason, 'unavailable', '不能用批次末尾放宽before')
  const history = [{ id: '1', contentJson: [{ type: 'knowledge-context', content_hashes: [sha('user：部署过去事实'), sha('会话摘要：部署旧摘要')] }] }] as unknown as PersistedHistoryRow[]
  assert.equal((await build(f.input({ history }))).injected, false)
  await f.pool.query('UPDATE conversation_sessions SET baseline_message_seq=10')
  const bounded = await build(f.input())
  assert.doesNotMatch(JSON.stringify(bounded), /部署旧摘要/, 'summary不能覆盖到本批锚点')
  await f.pool.query("UPDATE gugu_im_inbound_receipts SET state='claimed' WHERE message_id=99")
  assert.equal((await build(f.input())).reason, 'unavailable')
}))

test('只有当前已验证owner与显式group-owner政策可读owner；撤权/墓碑/旧租约均failclosed', { skip: !url && '需任务隔离PG', timeout: 30000 }, async () => fixture(async f => {
  await f.write('group', '部署本群公开记忆'); await f.write('owner', '部署owner私人记忆')
  await f.pool.query("UPDATE user_bots SET group_owner_memory_enabled=true; UPDATE conversation_messages SET platform_user_id='owner-user' WHERE run_id='synthetic-run'")
  const actor = { ...f.actor, platformUserId: 'owner-user', role: 'owner' as const, verifiedOwner: true, ownerMentionAuthorized: true, allowedToolNames: null }
  const lease = structuredClone(f.lease); assert.equal(lease.input.v, 3); if (lease.input.v === 3) lease.input.im.platformUserId = 'owner-user'
  const build = await f.build(actor, lease), result = await build(f.input())
  assert.equal(result.injected, true); assert.match(JSON.stringify(result), /owner私人记忆|owner独占知识/)
  await f.pool.query('UPDATE user_bots SET group_owner_memory_enabled=false')
  assert.equal((await build(f.input())).reason, 'unavailable')
  await f.pool.query('UPDATE user_bots SET group_owner_memory_enabled=true; UPDATE agent_run_dispatch SET fence=2')
  assert.equal((await build(f.input())).reason, 'unavailable')
  await f.pool.query('UPDATE agent_run_dispatch SET fence=1')
  await f.pool.query("INSERT INTO memory_scope_tombstones VALUES($1,'qq','97','group','room')", [f.owner])
  const restored = await build(f.input())
  assert.doesNotMatch(JSON.stringify(restored), /本群公开记忆|部署过去事实/)
}))

test('Telegram群owner不走旧Python缺平台分支的owner回落，私聊仅真实owner可自动检索', { skip: !url && '需任务隔离PG/FS', timeout: 30000 }, async () => fixture(async f => {
  await f.write('owner', '部署owner私人记忆')
  const path = join(f.root, f.owner, '.agent/memories/im/telegram/97/groups/room/memory.md')
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, '部署Telegram本群公开记忆')
  await f.pool.query("UPDATE user_bots SET platform='telegram'; UPDATE conversation_sessions SET source='telegram'; UPDATE gugu_im_inbound_receipts SET platform='telegram'; UPDATE conversation_messages SET platform_user_id='owner-user' WHERE run_id='synthetic-run'")
  const actor = { ...f.actor, platform: 'telegram' as const, platformUserId: 'owner-user', role: 'owner' as const, verifiedOwner: true, ownerMentionAuthorized: true, allowedToolNames: null }
  const lease = structuredClone(f.lease)
  if (lease.input.v === 3) { lease.input.im.platform = 'telegram'; lease.input.im.platformUserId = 'owner-user' }
  const group = await (await f.build(actor, lease))(f.input())
  assert.equal(group.injected, true); assert.match(JSON.stringify(group), /Telegram本群公开记忆/)
  assert.doesNotMatch(JSON.stringify(group), /owner私人|owner独占/)
  await f.pool.query("UPDATE conversation_sessions SET source='web',chat_type=NULL,chat_id=NULL,bot_id=NULL WHERE id=1; UPDATE gugu_im_inbound_receipts SET chat_type='c2c'")
  const privateActor = { ...actor, chatType: 'c2c' as const, chatId: null }
  if (lease.input.v === 3) { lease.input.im.chatType = 'c2c'; lease.input.im.chatId = null }
  const personal = await (await f.build(privateActor, lease))(f.input())
  assert.equal(personal.injected, true); assert.match(JSON.stringify(personal), /owner私人记忆/)
  // Telegram非owner私聊实际为unknown；用QQ真实member私聊规则验证同样不得回落owner。
  await f.pool.query("UPDATE user_bots SET platform='qq'; UPDATE gugu_im_inbound_receipts SET platform='qq'; UPDATE conversation_messages SET platform_user_id='member-a' WHERE run_id='synthetic-run'")
  const member = { ...privateActor, platform: 'qq' as const, role: 'member' as const, verifiedOwner: false, ownerMentionAuthorized: false, platformUserId: 'member-a', allowedToolNames: ['group_context_search'] }
  if (lease.input.v === 3) { lease.input.im.platform = 'qq'; lease.input.im.platformUserId = 'member-a' }
  assert.equal((await (await f.build(member, lease))(f.input())).reason, 'no_eligible_scope')
}))

test('自动RAG关闭不伪造命中，调用者取消可见，十秒预算返回明确timeout并排空待结束工作', { skip: !url && '需任务隔离PG', timeout: 30000 }, async () => fixture(async f => {
  const disabled = await f.build(undefined, undefined, () => false)
  assert.equal((await disabled(f.input())).reason, 'disabled')
  const build = await f.build(), controller = new AbortController(), original = new Error('合成调用者取消')
  const cancelled = build(f.input(), controller.signal)
  controller.abort(original)
  await assert.rejects(cancelled, error => error === original)
  let release!: () => void
  const held = new Promise<boolean>(resolve => { release = () => resolve(false) })
  const bounded = await f.build(undefined, undefined, () => held)
  try { assert.equal((await bounded(f.input())).reason, 'timeout') }
  finally { release(); await new Promise(resolve => setImmediate(resolve)) }
  assert.notEqual((await build(f.input())).reason, 'capacity_exceeded')
}))

test('真实Core assembler按PG历史seq取首锚，业务顺序相反的多currentUsers仍接通IM RAG并提交同一canonical区块', { skip: !url && '需真实隔离PG历史与索引', timeout: 30000 }, async () => fixture(async f => {
  await f.pool.query("INSERT INTO conversation_messages VALUES(300,1,'assistant','保留的旧历史',9,NULL,'2020-01-01Z',NULL,NULL,NULL)")
  const rows = await f.pool.query('SELECT id,role,content,conversation_seq FROM conversation_messages WHERE session_id=1 AND id=ANY(ARRAY[10,300,99,150]) ORDER BY conversation_seq')
  const history: PersistedHistoryRow[] = rows.rows.map(row => ({ ownerId: f.owner, sessionId: '1', id: String(row.id), role: row.role, content: row.content, conversationSeq: Number(row.conversation_seq) }))
  const factory = await f.build(), calls: { before: string | null; query: string; historyIds: string[] }[] = []
  const ports: PreparationPorts = { digest: value => sha(stableJson(value)), nextId: () => randomUUID(), async buildRag(input, signal) {
    calls.push({ before: input.beforeMessageId, query: input.query, historyIds: input.history.map(row => row.id) })
    return factory(input, signal)
  } }
  const input = { ownerId: f.owner, sessionId: '1', history, fixedPrefix: [], groupChat: true,
    currentUsers: [{ persistedMessageId: '150', rawText: '部署', message: { role: 'user' as const, content: '规范化后的媒体补充不应用作查询' } },
      { persistedMessageId: '99', rawText: '部署', message: { role: 'user' as const, content: '规范化后的引用不应用作查询' } }] }
  const rag = await buildRunRagContext(input, ports)
  assert.equal(rag.injected, true)
  assert.deepEqual(calls, [{ before: '99', query: '部署\n部署', historyIds: ['10', '300'] }])
  assert.doesNotMatch(JSON.stringify(rag), /当前第一锚点|当前第二锚点|未来消息/)
  const prepared = await prepareContext({ ...input, preparedRag: rag }, ports)
  assert.equal(calls.length, 1, 'Canonical prepare复用同一RAG，不重新查询或改水位')
  const canonical = prepared.area.entries.filter(entry => entry.source === 'rag')
  assert.equal(canonical.length, 1)
  assert.equal(canonical[0]!.persistencePolicy, 'commit_on_success')
  assert.deepEqual(canonical[0]!.message, rag.tail[0])
}))

test('真实PG scope版本相同且更新时间同毫秒不同微秒仍失效，RAG缓存不能返回旧文件', { skip: !url && '需真实PG微秒与Memory文件', timeout: 30000 }, async () => fixture(async f => {
  const scope = { type: 'group' as const, id: 'room', platform: 'qq', botId: '97' }
  await f.write('group', '部署微秒早版记忆')
  await f.pool.query("UPDATE memory_reflection_cursors SET scope_version=7,updated_at='2021-01-01 00:00:00.000100+00' WHERE scope_type='group' AND scope_id='room'")
  const first = await f.readScope({ ownerId: f.owner }, scope)
  const build = await f.build(), original = await build(f.input())
  assert.equal(original.injected, true); assert.match(JSON.stringify(original), /微秒早版记忆/)
  await f.write('group', '部署微秒新版记忆')
  await f.pool.query("UPDATE memory_reflection_cursors SET updated_at='2021-01-01 00:00:00.000900+00' WHERE scope_type='group' AND scope_id='room'")
  const second = await f.readScope({ ownerId: f.owner }, scope)
  assert.notEqual(first.revision, second.revision, '相同scope_version不能因pg Date毫秒截断而撞revision')
  assert.match(first.revision, /^7:/); assert.match(second.revision, /^7:/)
  const changed = await build(f.input())
  assert.equal(changed.injected, true); assert.match(JSON.stringify(changed), /微秒新版记忆/)
  assert.doesNotMatch(JSON.stringify(changed), /微秒早版记忆/)
}))
