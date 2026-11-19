import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { MessageArea, stableJson, formatCompactedSummary } from '@gugu/core/agent'
import type { CanonicalRunContext, RunCheckpoint } from '@gugu/core/agent'
import { createCanonicalHistoryWriter, canonicalBaselineHash } from '../../src/modules/agent-sessions/persistence/agent-canonical-write-postgres.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('历史增量与展示顺序同事务提交，回滚与重放不产生重复消息', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_write_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'synthetic-run' }
  try {
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, token_limit_6h integer, quota_window_started_at timestamptz);
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid,last_message_seq bigint NOT NULL,session_context jsonb, baseline_message_seq bigint DEFAULT 0, baseline_message_hash text, snapshot_hash text, context_epoch integer DEFAULT 1, session_info_hash text, snapshot_expires_at timestamptz);
      CREATE TABLE conversation_batches (id bigserial PRIMARY KEY,session_id integer,version text,run_id text,round_id text,digest text,created_at timestamptz,UNIQUE(session_id,digest));
      CREATE TABLE conversation_messages (id bigserial PRIMARY KEY,session_id integer,conversation_seq bigint,history_anchor_seq bigint,
        role text,content text,content_json jsonb,canonical_batch_id bigint,run_id text,round_id text,created_at timestamptz,
        sent_at timestamptz,im_platform_sent_ms bigint,im_event_received_ms bigint,files jsonb,display_timeline jsonb,covers_until_seq bigint);
      CREATE TABLE rag_index_jobs (id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation integer NOT NULL,completed_generation integer NOT NULL,attempts integer NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_started_at timestamptz,last_succeeded_at timestamptz,last_error_code text,pending_source_ids json NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type));
      CREATE TABLE agent_usage (user_id uuid, session_id integer, tokens_in integer, tokens_out integer, cache_read integer,
        cache_write integer,cache_round_stats jsonb,model text,provider text,is_byok boolean,tools_used jsonb,scenario text,input_source text,created_at timestamptz)`)
    await pool.query('INSERT INTO users (id) VALUES ($1)', [identity.ownerId])
    await pool.query('INSERT INTO conversation_sessions (id,user_id,last_message_seq,session_context) VALUES (1,$1,1,NULL)', [identity.ownerId])
    const anchor = await pool.query<{ id: string }>(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at,sent_at)
      VALUES (1,1,'user','问题',clock_timestamp(),clock_timestamp()) RETURNING id::text`)
    const area = new MessageArea({ digest, nextId: randomUUID })
    area.append({ role: 'user', content: '上下文' }, { source: 'rag', persistencePolicy: 'commit_on_success' })
    area.append({ role: 'user', content: '问题' }, { source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: anchor.rows[0]!.id })
    area.append({ role: 'assistant', content: '工具轮次' }, { source: 'tool_round', persistencePolicy: 'commit_on_success' })
    const context = { identity, modelIdentity: 'model', prepared: { area: area.snapshot() }, compactions: [],
      continuationRef: 'provider:synthetic-run', providerCacheAnchor: null } as unknown as CanonicalRunContext
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null }
    const checkpoint = { identity, totalUsage: zero, files: [], displayTimeline: [{ kind: 'assistant', text: '回答' }], providerRounds: [], calls: [] } as unknown as RunCheckpoint<CanonicalRunContext>
    const writer = createCanonicalHistoryWriter(async () => ({ defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }))
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await writer(client, identity, { outcome: 'success', context, text: '回答' }, checkpoint)
      await client.query('ROLLBACK')
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM conversation_messages')).rows[0].n), 1)
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM rag_index_jobs WHERE user_id=$1`, [identity.ownerId])).rows[0].n), 0)
      await client.query('BEGIN')
      await writer(client, identity, { outcome: 'success', context, text: '回答' }, checkpoint)
      await client.query('COMMIT')
      assert.equal(Number((await pool.query(`SELECT generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [identity.ownerId])).rows[0].generation), 1)
      const rows = await pool.query('SELECT role,content,history_anchor_seq FROM conversation_messages ORDER BY conversation_seq')
      assert.deepEqual(rows.rows.map(row => row.content), ['问题', '上下文', '工具轮次', '回答'])
      assert.equal(Number(rows.rows[1].history_anchor_seq), 1)
      await client.query('BEGIN')
      await assert.rejects(writer(client, identity, { outcome: 'success', context, text: '回答' }, checkpoint), /已提交/)
      await client.query('ROLLBACK')
      await pool.query(`UPDATE conversation_sessions SET snapshot_hash='snapshot',context_epoch=1 WHERE id=1`)
      const covered = await pool.query<{ id: string }>(`SELECT id::text FROM conversation_messages WHERE session_id=1
        ORDER BY coalesce(history_anchor_seq,conversation_seq), (history_anchor_seq IS NULL), conversation_seq LIMIT 2`)
      const nextIdentity = { ...identity, runId: 'second-run' }
      const snapshot = { ownerId: identity.ownerId, sessionId: '1', contextEpoch: 1, context: {}, snapshotHash: 'snapshot',
        sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }
      const emptyArea = new MessageArea({ digest, nextId: randomUUID })
      const compactContext = { ...context, identity: nextIdentity, continuationRef: null, prepared: { area: emptyArea.snapshot() },
        historyBaseline: { baselineSeq: 0, baselineHash: null, snapshotHash: 'snapshot' },
        sourceEffects: { sessionSnapshot: { state: snapshot } }, compactions: [
          { id: 'compact-1', result: { changed: true, coversUnpersisted: false,
            coversUntilMessageIds: [covered.rows[0]!.id], messages: [{ role: 'user', content: formatCompactedSummary('旧摘要') }] } },
          { id: 'compact-2', result: { changed: true, coversUnpersisted: false,
            coversUntilMessageIds: [covered.rows[1]!.id], messages: [{ role: 'user', content: formatCompactedSummary('历史摘要') }] } },
        ] } as unknown as CanonicalRunContext
      const compactCheckpoint = { ...checkpoint, identity: nextIdentity, displayTimeline: [], files: [] }
      await client.query('BEGIN')
      await writer(client, nextIdentity, { outcome: 'success', context: compactContext, text: '' }, compactCheckpoint)
      await client.query('COMMIT')
      assert.equal(Number((await pool.query(`SELECT generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [identity.ownerId])).rows[0].generation), 2)
      const saved = await pool.query('SELECT baseline_message_seq,baseline_message_hash FROM conversation_sessions WHERE id=1')
      assert.equal(Number(saved.rows[0].baseline_message_seq), 1)
      assert.ok(saved.rows[0].baseline_message_hash)
      const summary = await pool.query("SELECT content,covers_until_seq FROM conversation_messages WHERE role='summary'")
      assert.equal(summary.rows[0].content, '历史摘要')
      assert.equal(Number(summary.rows[0].covers_until_seq), 1)
      const privateWriter=createCanonicalHistoryWriter(async()=>({defaultLimit6h:null,byokEnabled:false,localDeployment:false,model:'model',provider:'provider',isByok:false}),
        {async commitContinuation(){throw new Error('成功私有状态发布钩子')}})
      for(const outcome of ['interruption','silent'] as const){
        const stopped={...identity,runId:`synthetic-${outcome}`},empty=new MessageArea({digest,nextId:randomUUID})
        const stoppedContext={...context,identity:stopped,prepared:{area:empty.snapshot()},continuationRef:'provider:synthetic-stopped'} as CanonicalRunContext
        await client.query('BEGIN')
        await privateWriter(client,stopped,{outcome,context:stoppedContext,text:''},{...checkpoint,identity:stopped,displayTimeline:[]})
        await client.query('ROLLBACK')
        await client.query('BEGIN')
        await assert.rejects(privateWriter(client,stopped,{outcome:'success',context:stoppedContext,text:''},{...checkpoint,identity:stopped,displayTimeline:[]}),/成功私有状态发布钩子/)
        await client.query('ROLLBACK')
      }
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('压缩候选发现基线并发变化时拒绝并且不写摘要或账本', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  const queries: string[] = []
  const client = { query: async (sql: string) => {
    queries.push(sql)
    if (sql.includes('last_message_seq')) return { rows: [{ last_message_seq: '3' }] }
    if (sql.includes('baseline_message_seq')) return { rows: [{ baseline: '3', baseline_hash: 'changed', snapshot_hash: 'snapshot', context_epoch: 2 }] }
    throw new Error('冲突后不应继续写入')
  } } as unknown as import('pg').PoolClient
  const context = { identity, modelIdentity: 'model', continuationRef: null, historyBaseline: { baselineSeq: 1, baselineHash: 'old', snapshotHash: 'snapshot' },
    sourceEffects: { sessionSnapshot: { state: { snapshotHash: 'snapshot', contextEpoch: 2 } } },
    compactions: [{ id: 'compaction', result: { changed: true, coversUntilMessageIds: ['1'] } }] } as unknown as CanonicalRunContext
  const writer = createCanonicalHistoryWriter(async () => ({ defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }))
  await assert.rejects(writer(client, identity, { outcome: 'success', context, text: '' }, { identity } as RunCheckpoint<CanonicalRunContext>), /基线已变化/)
  assert.equal(queries.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false)
})


test('摘要基线指纹与 Python 合成输入的完整 SHA-256 一致', () => {
  assert.equal(canonicalBaselineHash([
    { id: '1', role: 'user', content: '合成问题', content_json: null },
    { id: '2', role: 'assistant', content: '', content_json: [{ type: 'text', text: '合成答案' }] },
  ]), 'dc0993323646652b369072747378f6f0b3545996f5215b23ade586766fb2f6bd')
})

test('压缩包含未持久消息或旧候选缺少覆盖证据时不能推进水位', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  const client = { query: async (sql: string) => {
    if (sql.includes('last_message_seq')) return { rows: [{ last_message_seq: '3' }] }
    if (sql.includes('baseline_message_seq')) return { rows: [{ baseline: '1', baseline_hash: 'old', snapshot_hash: 'snapshot', context_epoch: 2 }] }
    throw new Error('缺少覆盖证据后不应访问其他数据')
  } } as unknown as import('pg').PoolClient
  const writer = createCanonicalHistoryWriter(async () => ({ defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }))
  for (const coversUnpersisted of [true, undefined]) {
    const context = { identity, modelIdentity: 'model', continuationRef: null,
      historyBaseline: { baselineSeq: 1, baselineHash: 'old', snapshotHash: 'snapshot' },
      sourceEffects: { sessionSnapshot: { state: { snapshotHash: 'snapshot', contextEpoch: 2 } } },
      compactions: [{ id: 'compaction', result: { changed: true, coversUnpersisted, coversUntilMessageIds: ['2'] } }] } as unknown as CanonicalRunContext
    await assert.rejects(writer(client, identity, { outcome: 'success', context, text: '' }, { identity } as RunCheckpoint<CanonicalRunContext>), /覆盖边界无效/)
  }
})
