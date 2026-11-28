import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sql } from 'kysely'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createRedisScheduledTaskCommands } from '../../../src/adapters/cache/redis-events.js'
import { clearRedisAgentReflectionSession, createRedisAgentReflectionInbox, createRedisAgentReflectionQueue } from '../../../src/modules/agent/memory/reflection/queue.js'
import { createLocalOwnerReflectionWriter } from '../../../src/modules/agent/memory/reflection/write.js'
import { createOwnerReflectionWork } from '../../../src/modules/agent/memory/reflection/work.js'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'
import { bindRecoverableProvider, createReflectionModelScope, type RecoverableProviderServices } from '../../../src/modules/agent/llm/recovery.js'
import { authorizeOwnerReflectionWrite, createPostgresOwnerReflectionSource } from '../../../src/modules/agent/memory/reflection/source.js'
import { createOwnerReflectionExtractor } from '../../../src/modules/agent/memory/reflection/model.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redis = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('Node 反思从已提交私聊读取证据，经原模型与持久发布写入记忆和重建队列', {
  skip: !url || !redis || process.platform !== 'linux', timeout: 30_000,
}, async () => {
  const schema = `reflection_model_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(join(tmpdir(), 'gugu-reflection-model-'))
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: url!, schema })
  const commands = createRedisScheduledTaskCommands(redis!)
  const ownerId = randomUUID(), other = randomUUID(), sessionId = '71'
  const first = { ownerId, sessionId, runId: 'first-run' }
  const second = { ...first, runId: 'second-run' }
  const revoked = { ...first, runId: 'revoked-run' }
  const later = { ...first, runId: 'later-run' }
  const deleted = { ...first, runId: 'deleted-run' }
  const oversized = { ...first, runId: 'oversized-run' }
  const signal = new AbortController().signal
  const longMessage = '首段证据' + '多行资料\n"🗂️"\\'.repeat(2500) + '尾段证据'
  const longReply = '用户已确认长资料'
  const fragments = { user: '', assistant: '' }
  let useLongTurn = false
  let modelVersion = '1', requests = 0, releases = 0
  const services: RecoverableProviderServices = {
    async select(_identity, _signal, ref) {
      assert.ok(!ref || ref === 'active')
      return { modelRef: 'active', configVersion: modelVersion, credentialVersion: '1',
        contextScopeKey: 'a'.repeat(64), accessScopeHash: 'b'.repeat(64),
        byokEnabled: false, localDeployment: false, defaultLimit6h: null,
        config: { provider: 'openai', api_format: 'openai', model: 'synthetic-reflection',
          base_url: 'https://provider.example.invalid/v1', api_key: 'synthetic', context_tokens: 16_000 },
        credential: null, systemPrompt: '合成主会话提示词', release() { releases++ } }
    },
    defaultBaseUrl() { throw new Error('意外读取备用地址') },
    decryptCredential() { throw new Error('意外读取凭据') },
  }
  const secret = 'synthetic-reflection-secret'
  const modelScope = createReflectionModelScope(secret)
  const bind = (identity: typeof first, signal: AbortSignal, recovery?: Parameters<typeof bindRecoverableProvider>[4]) =>
    bindRecoverableProvider(identity, services, secret, signal, recovery)
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ddl = tablesSql('postgres')
    await pool.query([ddl.receipts, ddl.ragJobs,
      'CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean DEFAULT true,account_status text,display_name text,username text,timezone text,token_limit_6h integer,quota_window_started_at timestamptz)',
      'CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid NOT NULL,mode text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL)',
      "CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,source text,chat_type text,execution_state text DEFAULT 'idle',pending_message_count integer DEFAULT 0,active_run_id text)",
      'CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL,run_id text,role text,content text,conversation_seq bigint,created_at timestamptz DEFAULT now(),canonical_batch_id bigint)',
      'CREATE TABLE agent_usage(user_id uuid,session_id integer,tokens_in integer,tokens_out integer,cache_read integer,cache_write integer,cache_round_stats jsonb,model text,provider text,is_byok boolean,tools_used jsonb,scenario text,input_source text,created_at timestamptz)',
    ].join(';\n'))
    await pool.query("INSERT INTO users(id,username,timezone) VALUES ($1,'小北','UTC'),($2,'合成用户','UTC')", [ownerId, other])
    await pool.query("INSERT INTO conversation_sessions(id,user_id,source) VALUES (71,$1,'web'),(72,$2,'web')", [ownerId, other])
    await pool.query(`INSERT INTO conversation_messages(id,session_id,run_id,role,content,conversation_seq,canonical_batch_id)
      VALUES (1,71,'first-run','user','整理虚构资料',1,NULL),(2,71,'first-run','assistant','私有中间证据',2,1),
      (3,71,'first-run','assistant','已整理虚构资料',3,NULL),(4,71,'revoked-run','user','权限撤回的内容',4,NULL),
      (5,71,'revoked-run','assistant','权限撤回的回复',7,NULL),(6,72,'first-run','user','另一账户内容',1,NULL),
      (7,71,'second-run','user','追加虚构资料',4,NULL),(8,71,'second-run','assistant','已追加虚构资料',5,NULL),
      (9,71,'later-run','user','保留剩余资料',8,NULL),(10,71,'later-run','assistant','仍可反思的资料',9,NULL)`)
    await pool.query(`INSERT INTO conversation_messages(id,session_id,run_id,role,content,conversation_seq)
      VALUES (11,71,$1,'user',$2,10),(12,71,$1,'assistant',$3,11)`, [oversized.runId, longMessage, longReply])
    await applyRagIndexMigration(pool)
    await mkdir(join(root, ownerId), { recursive: true })
    const source = createPostgresOwnerReflectionSource(pool)
    const submitted = { ...first, turns: [{ runId: first.runId, userMessageId: '1' }] }
    assert.equal((await source({ ...first, ownerId: other, turns: [{ runId: first.runId, userMessageId: '1' }] }, signal)).kind, 'discard')
    assert.equal((await source({ ...first, turns: [{ runId: first.runId, userMessageId: '6' }] }, signal)).kind, 'discard')
    await pool.query("UPDATE conversation_sessions SET pending_message_count=1 WHERE id=71")
    assert.equal((await source(submitted, signal)).kind, 'defer')
    await pool.query("UPDATE conversation_sessions SET pending_message_count=0,chat_type='group' WHERE id=71")
    assert.equal((await source(submitted, signal)).kind, 'discard')
    await pool.query("UPDATE conversation_sessions SET chat_type=NULL WHERE id=71")
    const writer = createLocalOwnerReflectionWriter({ core, storageRoot: root, authorize: authorizeOwnerReflectionWrite })
    let reflectionClock = Date.now()
    const enqueue = createRedisAgentReflectionQueue({ commands, modelScope, now: () => reflectionClock })
    const claim = createRedisAgentReflectionInbox({ commands, now: () => reflectionClock })
    const work = createOwnerReflectionWork({ claim, writer, checkSource: source,
      extract: createOwnerReflectionExtractor({ bind, modelScope, source, pool, timezone: 'UTC', async canSpend() { return true },
        async readPrompt() { return '生成虚构记忆增量 JSON' },
        context: {
          digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
          nextId: randomUUID,
          references: { async dehydrate(entry) { return entry.message }, async hydrate(entry) { return entry.message } },
          async prepareRequest() { throw new Error('反思不应生成主请求') },
        },
        transport: () => ({ snapshot: () => ({ networkIdentity: 'synthetic', create: () => ({
          async request(request) {
            requests++
            let content = '{"summary":"整理了虚构资料"}'
            if (useLongTurn) {
              const { messages, max_tokens: budget } = request.body as { messages: { content: string }[]; max_tokens: number }
              assert.ok(Buffer.byteLength(messages.map(row => row.content).join('')) + budget + 256 <= 16_000)
              const evidence = JSON.parse(messages.at(-1)!.content)
              if (evidence.condensedEvidence) {
                assert.equal(evidence.allowMemoryRemoval, false)
                assert.equal(fragments.user, longMessage)
                assert.equal(fragments.assistant, longReply)
                assert.match(evidence.turns[0].userMessage, /用户片段摘要/u)
                assert.equal(evidence.turns[0].assistantReply, '助手片段摘要')
                assert.doesNotMatch(messages.at(-1)!.content, /多行资料/u)
                content = '{"summary":"长回合已恢复","profile_remove":["保留的已有资料"]}'
              } else {
                assert.ok(evidence.role === 'user' || evidence.role === 'assistant')
                fragments[evidence.role as keyof typeof fragments] += evidence.text
                content = evidence.role === 'user' ? '用户片段摘要' : '助手片段摘要'
              }
            } else {
              assert.match(JSON.stringify(request.body), requests === 1
                ? /已整理虚构资料[\s\S]*已追加虚构资料/u : /仍可反思的资料/u)
              assert.doesNotMatch(JSON.stringify(request.body), /私有中间证据|另一账户内容|权限撤回/u)
            }
            const body = JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 } })
            return { status: 200, headers: { 'content-type': 'application/json' },
              body: (async function* () { yield new TextEncoder().encode(body) })(), cancel() {} }
          }, async close() {},
        }) }) }),
        diagnose: () => assert.fail('合成模型不应失败'),
      }), diagnose: () => assert.fail('反思批次不应失败'),
    })
    for (const [identity, userMessageId] of [[first, '1'], [second, '7']] as const) {
      const model = await bind(identity, signal)
      await enqueue({ identity, userMessageId, modelIdentity: model.modelIdentity, accessScopeHash: model.accessScopeHash,
        userMessage: '待处理的合成请求', usedTools: false })
      model.release()
      if (identity === first) assert.equal(await work(signal), 'idle')
    }
    reflectionClock += 180_000
    assert.equal(await work(signal), 'ready')
    assert.equal(requests, 1)
    assert.equal(JSON.parse(await readFile(join(root, ownerId, '.agent', 'memories', 'summary.json'), 'utf8')).text, '整理了虚构资料')
    assert.deepEqual((await pool.query('SELECT scenario,tokens_in,tokens_out FROM agent_usage')).rows,
      [{ scenario: 'reflection', tokens_in: 10, tokens_out: 5 }])
    assert.equal((await pool.query("SELECT status FROM rag_index_jobs WHERE user_id=$1 AND source_type='memory'", [ownerId])).rows[0].status, 'queued')
    const old = await bind(revoked, signal)
    await enqueue({ identity: revoked, userMessageId: '4', modelIdentity: old.modelIdentity, accessScopeHash: old.accessScopeHash,
      userMessage: '待处理的合成请求', usedTools: false })
    old.release()
    modelVersion = '2'
    reflectionClock += 180_000
    assert.equal(await work(signal), 'ready')
    assert.equal(requests, 1, '模型版本变化后禁止发送队列里的会话内容')
    assert.equal(releases, 5)
    for (const [identity, userMessageId] of [[deleted, '99'], [later, '9']] as const) {
      const model = await bind(identity, signal)
      await enqueue({ identity, userMessageId, modelIdentity: model.modelIdentity, accessScopeHash: model.accessScopeHash,
        userMessage: '处理合成资料', usedTools: false })
      model.release()
    }
    reflectionClock += 180_000
    assert.equal(await work(signal), 'ready', '缺失回合与同批有效回合分开')
    assert.equal(await work(signal), 'ready', '只结算已删除回合')
    assert.equal(requests, 1)
    assert.equal(await work(signal), 'ready', '有效回合仍经模型和发布边界')
    assert.equal(requests, 2)
    assert.equal(await claim(), null)
    const existing = [{ type: 'note', text: '保留的已有资料' }]
    await writeFile(join(root, ownerId, '.agent', 'memories', 'profile.json'), JSON.stringify(existing))
    const longModel = await bind(oversized, signal)
    await enqueue({ identity: oversized, userMessageId: '11', modelIdentity: longModel.modelIdentity,
      accessScopeHash: longModel.accessScopeHash, userMessage: longMessage, usedTools: false })
    longModel.release()
    useLongTurn = true
    reflectionClock += 180_000
    assert.equal(await work(signal), 'ready')
    assert.ok(requests > 4)
    assert.equal(JSON.parse(await readFile(join(root, ownerId, '.agent', 'memories', 'summary.json'), 'utf8')).text, '长回合已恢复')
    assert.deepEqual(JSON.parse(await readFile(join(root, ownerId, '.agent', 'memories', 'profile.json'), 'utf8')), existing)
    assert.equal(Number((await pool.query("SELECT count(*) FROM agent_usage WHERE scenario='reflection'")).rows[0].count), requests)
    assert.equal(await claim(), null)
  } finally {
    await clearRedisAgentReflectionSession(commands, ownerId, sessionId).catch(() => undefined)
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})

test('反思批次发布和恢复复用 PostgreSQL 收据，Redis 回执保留用户隔离', {
  skip: !url || !redis || process.platform !== 'linux',
  timeout: 15_000,
}, async () => {
  const schema = `reflect_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(join(tmpdir(), 'gugu-reflection-publish-'))
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: url!, schema })
  const commands = createRedisScheduledTaskCommands(redis!)
  const ownerId = randomUUID(), other = randomUUID(), sessionId = '41'
  const signal = new AbortController().signal
  const base = join(root, ownerId, '.agent')
  const readJson = async (name: string) => JSON.parse(await readFile(join(base, name), 'utf8'))
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ddl = tablesSql('postgres')
    await pool.query([ddl.receipts, ddl.ragJobs, 'CREATE TABLE users(id uuid PRIMARY KEY)',
      'CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid NOT NULL,mode text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL)',
      'CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL)',
    ].join(';\n'))
    await pool.query('INSERT INTO users VALUES ($1),($2)', [ownerId, other])
    await pool.query('INSERT INTO conversation_sessions VALUES (41,$1),(42,$2)', [ownerId, other])
    await applyRagIndexMigration(pool)
    await mkdir(base, { recursive: true })
    await writeFile(join(base, 'profile.json'), JSON.stringify([{ type: 'note', text: '保持原有偏好' }]))
    await writeFile(join(base, 'pattern.json'), JSON.stringify([
      { id: 'old', text: '合成工作流程偏好', kind: 'observed', conf: 0.7, imp: 2 },
      { id: 'obsolete', text: '即将被清除的偏好', kind: 'inferred', conf: 0.6, imp: 3 },
    ]))
    await writeFile(join(base, 'pattern_vec.json'), JSON.stringify({ old: { v: [1], t: 's' }, obsolete: { v: [2], t: 's' } }))
    await writeFile(join(base, 'daily.md'), '## 2026-11-18\n- 之前保存的合成事项\n')
    let denyOnAuthorization = 0
    const writer = createLocalOwnerReflectionWriter({ core, storageRoot: root,
      async authorize(tx, batch) {
        if (denyOnAuthorization && --denyOnAuthorization === 0) return false
        return (await sql`SELECT id FROM conversation_sessions WHERE id=${batch.sessionId} AND user_id=${batch.ownerId}`.execute(tx)).rows.length === 1
      },
    })
    const enqueue = createRedisAgentReflectionQueue({ commands, modelScope: () => 'synthetic-model-scope' })
    const claim = createRedisAgentReflectionInbox({ commands, now: () => Date.now() + 180_000 })
    await enqueue({ identity: { ownerId, sessionId, runId: 'synthetic-reflection' }, modelIdentity: 'synthetic-model',
      accessScopeHash: 'synthetic-scope', userMessageId: '41', userMessage: '整理资料', usedTools: true })
    const batch = await claim()
    assert.ok(batch)
    assert.equal(batch.ownerId, ownerId)
    await assert.rejects(writer.snapshot({ ...batch, ownerId: other }, signal), /授权暂不可用/)
    assert.equal(await writer.reconcile(batch, signal), null)
    const snapshot = await writer.snapshot(batch, signal)
    const time = { now: 1_800_000_000, date: '2026-11-18' }
    const output = {
      profile_add: [{ type: 'preference', text: '偏好简短的合成标题' }],
      profile_remove: ['保持原有偏'], // 文本没有精确锚到快照条目，不能删。
      pattern_remove: ['即将被清除的偏好'],
      pattern_add: [
        { text: '合成工作流程偏好', kind: 'inferred', importance: 4 },
        { text: '每周挑时间独立归档', kind: 'inferred', importance: 3 },
      ],
      summary: '正在确认合成任务', daily: '整理合成资料', perception: { intent: '记录' },
    }
    await writeFile(join(base, 'summary.json'), JSON.stringify({ text: '较新合成状态' }))
    assert.equal(await writer.publish(batch, snapshot.version, output, time, signal), 'stale')
    const current = await writer.snapshot(batch, signal)
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT block_reflection_queue CHECK(status <> 'queued')")
    await assert.rejects(writer.publish(batch, current.version, output, time, signal))
    assert.deepEqual(await readJson('summary.json'), { text: '正在确认合成任务', ts: time.now })
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT block_reflection_queue')
    assert.equal(await batch.retry(0), true)
    let extracted = 0
    const work = createOwnerReflectionWork({ claim, writer, async extract() {
      extracted++
      throw new Error('有持久计划时不能重新调用模型')
    }, diagnose: () => assert.fail('已暂存计划应能恢复') })
    assert.equal(await work(signal), 'ready')
    assert.equal(extracted, 0)
    assert.equal(await writer.reconcile(batch, signal), 'applied')
    assert.equal(await batch.complete(), false)
    assert.equal(await claim(), null)
    assert.deepEqual((await readJson('profile.json')).map((row: { text: string }) => row.text), ['保持原有偏好', '偏好简短的合成标题'])
    const patterns = await readJson('pattern.json')
    assert.equal(patterns.length, 2)
    assert.equal(patterns[0].kind, 'observed')
    assert.equal(patterns[1].kind, 'inferred')
    assert.deepEqual(await readJson('pattern_vec.json'), { old: { v: [1], t: 's' } })
    assert.deepEqual(await readJson('stance.json'), { stance: '记录', ts: time.now })
    assert.equal(await readFile(join(base, 'daily.md'), 'utf8'), '## 2026-11-18\n- 整理合成资料\n- 之前保存的合成事项\n')
    const receipts = await pool.query('SELECT result_json FROM core_operation_receipts')
    assert.equal(receipts.rowCount, 2)
    assert.doesNotMatch(JSON.stringify(receipts.rows), /合成资料|合成标题|合成任务/u)
    assert.equal((await pool.query("SELECT status FROM rag_index_jobs WHERE user_id=$1 AND source_type='memory'", [ownerId])).rows[0].status, 'queued')

    await enqueue({ identity: { ownerId, sessionId, runId: 'later-reflection' }, modelIdentity: 'synthetic-model',
      accessScopeHash: 'synthetic-scope', userMessageId: '41', userMessage: '修改资料', usedTools: true })
    const later = await claim()
    assert.ok(later)
    await assert.rejects(writer.snapshot({ ...later, isCurrent: async () => false }, signal), /授权暂不可用/)
    const beforeLater = await writer.snapshot(later, signal)
    denyOnAuthorization = 2
    await assert.rejects(writer.publish(later, beforeLater.version, { summary: '待发布的旧结果' }, time, signal))
    await writeFile(join(base, 'summary.json'), JSON.stringify({ text: '手动写入的新状态' }))
    assert.equal(await writer.reconcile(later, signal), 'superseded')
    assert.equal((await readJson('summary.json')).text, '手动写入的新状态')
    assert.equal((await pool.query("SELECT status FROM rag_index_jobs WHERE user_id=$1 AND source_type='memory'", [ownerId])).rows[0].status, 'queued')
    assert.equal(await later.complete(), true)
  } finally {
    await clearRedisAgentReflectionSession(commands, ownerId, sessionId).catch(() => undefined)
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})

test('Owner 反思证据查询按会话与 Run 锚点筛选，缺一条证据时请求拆批', { skip: !url }, async () => {
  const schema = `reflection_scope_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    const owner = randomUUID(), other = randomUUID()
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, username text, display_name text, timezone text, is_active boolean, account_status text);
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid, execution_state text, pending_message_count integer, active_run_id text, source text, chat_type text);
      CREATE TABLE conversation_messages (id integer PRIMARY KEY, session_id integer, role text, run_id text,
        content text, created_at timestamptz, canonical_batch_id integer, conversation_seq integer)`)
    await pool.query("INSERT INTO users VALUES ($1,'小北',NULL,'UTC',TRUE,'active'), ($2,'小南',NULL,'UTC',TRUE,'active')", [owner, other])
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'idle',0,NULL,'web',NULL),(2,$2,'idle',0,NULL,'web',NULL),(3,$1,'idle',0,NULL,'web','group')", [owner, other])
    await pool.query(`INSERT INTO conversation_messages VALUES
      (1,1,'user','run-a','本次问题','2026-01-01T00:00:00Z',NULL,1),
      (2,1,'assistant','run-a','中间过程','2026-01-01T00:00:01Z',22,2),
      (3,1,'assistant','run-a','本次终态回复','2026-01-01T00:00:02Z',NULL,3),
      (4,2,'user','run-b','其他账户问题','2026-01-01T00:00:00Z',NULL,1)`)
    const read = createPostgresOwnerReflectionSource(pool)
    const signal = new AbortController().signal
    const batch = { ownerId: owner, sessionId: '1', turns: [{ userMessageId: '1', runId: 'run-a' }] }
    assert.deepEqual(await read(batch, signal), { kind: 'ready', userName: '小北', timezone: 'UTC',
      turns: [{ userMessage: '本次问题', assistantReply: '本次终态回复', timestamp: '2026-01-01T00:00:00.000Z' }] })
    assert.deepEqual(await read({ ...batch, ownerId: other }, signal), { kind: 'discard' })
    assert.deepEqual(await read({ ...batch, sessionId: '3' }, signal), { kind: 'discard' })
    assert.deepEqual(await read({ ...batch, turns: [...batch.turns, { userMessageId: '4', runId: 'run-b' }] }, signal), { kind: 'split' })
    await pool.query("UPDATE conversation_sessions SET execution_state='running' WHERE id=1")
    assert.deepEqual(await read(batch, signal), { kind: 'defer' })
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
