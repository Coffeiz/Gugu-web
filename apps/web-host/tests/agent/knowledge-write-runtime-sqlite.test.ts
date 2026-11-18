import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createPostgresRuntime, initializeSqlite, openSqliteRuntime, tablesSql } from '@gugu/core/data'
import { createKnowledgeRagSource, enqueueAgentRagRebuild, invalidateAgentKnowledgeRag } from '@gugu/core/agent/rag'
import { parseAgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { createKnowledgeDeleteTool } from '@gugu/core/tools'
import { buildDocuments } from '../../../../packages/core/src/agent/rag/adapters/base.js'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createSqlRagRebuildWorker } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/domains/agent-sessions/tools/agent-rag-knowledge-store.js'
import { createLocalAgentKnowledgeDeletePort, createLocalAgentKnowledgeWritePort } from '../../src/domains/agent-sessions/tools/agent-knowledge-write.js'
import { applyRagIndexMigration } from '../../src/migrations/rag-index-migrate.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../src/domains/agent-sessions/tools/agent-confirmation.js'
import { createPostgresTrustedIntentStore } from '../../src/domains/agent-sessions/persistence/agent-trusted-intent-postgres.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('知识删除在文件发布后提交失败仍可恢复，保留历史并移除 PostgreSQL 索引', { skip: !pgUrl }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-knowledge-remove-'))
  const schema = `gugu_knowledge_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: pgUrl!, schema })
  const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'knowledge-remove' }
  const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
  const signal = new AbortController().signal
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ddl = tablesSql('postgres')
    await pool.query([ddl.ragJobs, ddl.receipts, `
      CREATE TABLE users(id uuid PRIMARY KEY,security_version integer DEFAULT 1,is_active boolean DEFAULT true,account_status text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,
        ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text);
      CREATE TABLE agent_interaction_bindings(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text);
      CREATE TABLE interaction_prompts(id integer,user_id uuid,session_id integer,kind text,status text,expires_at timestamptz,schema_json jsonb);
      CREATE TABLE interaction_actions(prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz)
    `].join(';\n'))
    await pool.query('INSERT INTO users(id) VALUES ($1)', [identity.ownerId])
    await applyRagIndexMigration(pool)
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2)', [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId, lease.token])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,$2,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId])
    const store = createLocalAgentKnowledgeReadStore(root)
    const writes = createLocalAgentKnowledgeWritePort(core, root, store)
    const source = { type: 'user' as const, ref: '', label: '', checked_at: null }
    const seed = {
      id: 'entry-one', title: '合成知识', content: '当前知识正文', topic: '', description: '', keywords: [],
      scope: { type: 'owner', owner_user_id: identity.ownerId, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
      source, confidence: 'confirmed' as const, version: 2, parent_id: null, created_at: 1700000000, updated_at: 1700000001,
      active: true, history: [{ version: 1, title: '合成知识', content: '历史知识正文', keywords: [], source, confidence: 'confirmed', updated_at: 1700000000 }],
    }
    await writes.commit(identity, { ...seed, version: 1, history: [] }, signal)
    await writes.commit(identity, seed, signal)
    await writes.commit(identity, { ...seed, id: 'entry-two', title: '保留知识', version: 1, history: [] }, signal)
    const fileKey = `${identity.ownerId}/.agent/knowledge/entries/${seed.id}.md`
    const work = createSqlRagRebuildWorker(core.db, 'postgres', { knowledge: createKnowledgeRagSource(store) })
    const index = createSqlRagPersistentIndexReader(core.db, 'postgres')
    assert.equal(await work(), 'ready')
    const indexedIds = async () => [...new Set((await index.snapshot(identity.ownerId)).documents.map(item => item.source_id))].sort()
    assert.deepEqual(await indexedIds(), ['entry-one', 'entry-two'])
    const intents = createPostgresTrustedIntentStore(() => 'synthetic-knowledge-master', 1)
    const createConfirmation = () => createWebAgentToolConfirmation({
      pool, lease, intents, action: 'delete_knowledge',
      ...createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return lease.input.accessVersion } }),
      async describe(_binding, snapshot) {
        assert.match(snapshot.displaySummary ?? '', /合成知识/u)
        return { summary: snapshot.displaySummary! }
      },
    })
    const createRegistry = () => createAuthorizedWebAgentProductionRagRunPorts({
      core, pool, lease, storageRoot: root, enabled: () => true,
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      knowledgeDelete: createKnowledgeDeleteTool(createLocalAgentKnowledgeDeletePort(core, root, store, createConfirmation())),
    }).toolRegistry
    const registry = createRegistry()
    const scope = { identity, roundId: '1', signal, resolution: null,
      async execute(): Promise<never> { throw new Error('知识删除不调用沙盒') } }
    const call = { id: 'delete', name: 'delete_knowledge', input: { knowledge_id: seed.id } }
    const waiting = await registry.tools.dispatch(call, scope)
    assert.ok(waiting.kind === 'waiting')
    const interaction = waiting.interaction.id
    const countIntents = async () => (await pool.query('SELECT count(*)::int AS n FROM agent_interaction_intents')).rows[0].n
    assert.equal(await countIntents(), 1)
    // 只模拟 Web 用户提交确认后的投影；意图签发、加载、事务认领及收据走生产适配器。
    await pool.query('INSERT INTO agent_interaction_bindings VALUES ($1,1,$2,9,$3,$4)', [identity.ownerId, identity.runId, interaction, call.id])
    await pool.query("INSERT INTO agent_interaction_resumes VALUES ($1,1,$2,9,$3,'web-prompt:9')", [identity.ownerId, identity.runId, interaction])
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,1,$2,'web-prompt:9')", [identity.ownerId, identity.runId])
    const code = 'synthetic-knowledge-code'
    await pool.query("INSERT INTO interaction_prompts VALUES (9,$1,1,'confirm','resolved',CURRENT_TIMESTAMP+interval '2 minutes',$2)",
      [identity.ownerId, { context: { confirm_code: code }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } }])
    await pool.query("INSERT INTO interaction_actions VALUES (9,'consumed','confirm','confirm',$1,CURRENT_TIMESTAMP+interval '2 minutes')",
      [{ tool_call_id: call.id, tool_name: call.name, confirm_code: code }])
    const resume = { ...scope, resolution: { interactionId: interaction, receiptId: 'web-prompt:9', status: 'confirmed' as const, value: {} } }
    const forged = await registry.tools.dispatch(call, { ...resume, resolution: { ...resume.resolution, receiptId: 'forged' } })
    assert.ok(forged.kind === 'completed' && !forged.successful)
    assert.equal(parseAgentKnowledgeEntry(await store.read(fileKey)).active, true)
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT block_plan CHECK(status <> 'ready') NOT VALID")
    assert.equal((await registry.tools.dispatch(call, resume)).kind, 'unknown')
    assert.equal(await countIntents(), 1)
    assert.equal(parseAgentKnowledgeEntry(await store.read(fileKey)).active, true)
    assert.deepEqual(await indexedIds(), ['entry-one', 'entry-two'])
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT block_plan')
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT block_rebuild CHECK(status <> 'queued')")
    assert.equal((await registry.tools.dispatch(call, resume)).kind, 'unknown')
    assert.deepEqual(parseAgentKnowledgeEntry(await store.read(fileKey)), { ...seed, active: false })
    assert.equal(await countIntents(), 0)
    assert.deepEqual(await indexedIds(), ['entry-two'])
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT block_rebuild')
    const recovered = await createRegistry().tools.reconcile(call, { ...identity, roundId: scope.roundId })
    assert.ok(recovered.kind === 'completed' && recovered.successful)
    assert.deepEqual(recovered.value, { success: true, knowledge_id: seed.id })
    const replay = await createRegistry().tools.dispatch(call, resume)
    assert.ok(replay.kind === 'completed' && replay.successful && !replay.mutated)
    assert.equal(await work(), 'ready')
    assert.deepEqual(await indexedIds(), ['entry-two'])
    await assert.rejects(writes.commit(identity, { ...seed, version: 3 }, signal), /知识条目已变化/u)
  } finally {
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})

test('knowledge 文件变更先墓碑化旧索引并围栏已经读取旧文件的 Worker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-knowledge-invalidate-'))
  const database = path.join(directory, 'core.sqlite')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  try {
    const documents = buildDocuments({ id: 'knowledge-k1', source_type: 'knowledge', title: '合成知识',
      content: '旧知识内容在修改后必须不可检索', document_version: '1:krevision',
      scope: { scope_type: 'owner', scope_id: ownerId } })
    const writer = createSqlRagPersistentIndexWriter(runtime.db, 'sqlite')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'sqlite')
    await writer.replaceSource(ownerId, 'knowledge', documents)
    await enqueueAgentRagRebuild(runtime.db, 'sqlite', ownerId, 'knowledge')
    let release!: () => void
    let started!: () => void
    const readStarted = new Promise<void>(resolve => { started = resolve })
    const allowCommit = new Promise<void>(resolve => { release = resolve })
    const worker = createSqlRagRebuildWorker(runtime.db, 'sqlite', { knowledge: async () => { started(); await allowCommit; return documents } })
    const inFlight = worker()
    await readStarted
    const before = await (runtime.db as any).selectFrom('rag_index_jobs').select(['generation', 'status'])
      .where('source_type', '=', 'knowledge').executeTakeFirstOrThrow()
    assert.equal(before.status, 'running')
    await invalidateAgentKnowledgeRag(runtime.db, 'sqlite', ownerId)
    release()
    assert.equal(await inFlight, 'superseded')
    assert.deepEqual((await reader.snapshot(ownerId)).documents, [])
    assert.deepEqual(await (runtime.db as any).selectFrom('rag_index_jobs')
      .select(['generation', 'completed_generation', 'status', 'lease_until']).where('source_type', '=', 'knowledge').executeTakeFirst(), {
      generation: Number(before.generation) + 1, completed_generation: Number(before.generation) + 1, status: 'ready', lease_until: null,
    })
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Host 工具调用写入 owner Markdown 并经持久 Worker 重建知识索引', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gugu-knowledge-write-'))
  const root = path.join(directory, 'storage')
  const database = path.join(directory, 'core.sqlite')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const entriesDirectory = path.join(root, ownerId, '.agent', 'knowledge', 'entries')
  await mkdir(entriesDirectory, { recursive: true })
  await writeFile(path.join(entriesDirectory, 'legacy-knowledge.md'), `---
id: legacy-knowledge
title: 部署回滚
topic: 生产发布
keywords_json: ["回滚"]
description: 发布异常时使用
scope_json: {"type":"owner","owner_user_id":"${ownerId}","platform":"","bot_id":"","group_id":"","scope_id":"","project_id":""}
source_json: {"type":"user","ref":"","label":"","checked_at":null}
confidence: confirmed
version: 1
parent_id: 
created_at: 1760000000
updated_at: 1760000000
active: true
history_json: []
---
旧回滚正文
`)
  const store = createLocalAgentKnowledgeReadStore(root)
  const identity = { ownerId, sessionId: '1', runId: 'knowledge-write-test' }
  const otherOwner = '00000000-0000-4000-8000-000000000099'
  const registry = createAgentToolRegistry({ core: runtime,
    knowledgeWrites: createLocalAgentKnowledgeWritePort(runtime, root, store),
    authorize: async (current, name) => [ownerId, otherOwner].includes(current.ownerId) && ['save_knowledge', 'update_knowledge'].includes(name),
  })
  const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('知识工具不能执行宿主进程') } }
  try {
    const available = await registry.capabilities(identity)
    assert.deepEqual(available.filter(item => item.name.endsWith('_knowledge')).map(item => item.name).sort(), ['save_knowledge', 'update_knowledge'])
    const saved = await registry.tools.dispatch({ id: 'save-1', name: 'save_knowledge', input: {
      title: '部署回滚', topic: '生产发布', content: '先检查健康探针，再回滚上一版本。', keywords: ['回滚', '健康探针'],
      description: '发布异常时使用', source_type: 'user',
    } }, scope)
    assert.equal(saved.kind === 'completed' && saved.successful, true)
    const result = saved.kind === 'completed' && saved.successful ? saved.value as { id: string; index_status: string } : null
    assert.ok(result?.id)
    assert.equal(result?.index_status, 'queued')

    const marker = await store.exists(`${ownerId}/.agent/knowledge/.timestamps-iso-v1`)
    const raw = await store.read(`${ownerId}/.agent/knowledge/entries/${result!.id}.md`)
    assert.equal(marker, true)
    assert.match(new TextDecoder().decode(raw), /先检查健康探针，再回滚上一版本/u)
    assert.match(new TextDecoder().decode(raw), /created_at: 2025-10-09T08:53:20\.000000Z/u)
    assert.match(new TextDecoder().decode(raw), /旧回滚正文/u)
    const db = runtime.db as any
    assert.deepEqual(await db.selectFrom('rag_index_jobs').select(['status', 'generation'])
      .where('user_id', '=', ownerId.replaceAll('-', '')).where('source_type', '=', 'knowledge').executeTakeFirst(), { status: 'queued', generation: 2 })

    const worker = createSqlRagRebuildWorker(runtime.db, 'sqlite', { knowledge: createKnowledgeRagSource(store) })
    assert.equal(await worker(), 'ready')
    const indexed = await createSqlRagPersistentIndexReader(runtime.db, 'sqlite').snapshot(ownerId)
    assert.equal(indexed.documents.some(document => document.source_type === 'knowledge'
      && document.source_id === result!.id && document.content === '先检查健康探针，再回滚上一版本。'), true)

    const otherIdentity = { ...identity, ownerId: otherOwner }
    const otherScope = { ...scope, identity: otherIdentity }
    const foreignUpdate = await registry.tools.dispatch({ id: 'foreign-update', name: 'update_knowledge', input: {
      knowledge_id: result!.id, content: '另一 owner 不能覆盖此条目。',
    } }, otherScope)
    assert.equal(foreignUpdate.kind === 'completed' && foreignUpdate.successful, false)
    assert.equal(await store.exists(`${otherIdentity.ownerId}/.agent/knowledge/entries/${result!.id}.md`), false)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
