import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { MessageArea, stableJson, formatCompactedSummary, formatAgentHistoryMessageTime, prepareContext, selectSessionHistory, restoreHistoryForRequest } from '@gugu/core/agent'
import type { CanonicalRunContext, RunCheckpoint } from '@gugu/core/agent'
import { createCanonicalHistoryWriter, canonicalBaselineHash } from '../../../src/modules/agent/chat/write.js'

import { createPostgresCanonicalHistoryReader } from '../../../src/modules/agent/chat/canonical.js'
import { createPostgresCurrentTurnReader } from '../../../src/modules/agent/context/source.js'
import { createWebCurrentMessageMaterializer } from '../../../src/modules/agent/context/message.js'
import { persistRunCompaction } from '../../../src/modules/agent/chat/compact.js'

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
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid,last_message_seq bigint NOT NULL,session_context jsonb, baseline_message_seq bigint DEFAULT 0, baseline_message_hash text, snapshot_hash text, context_epoch integer DEFAULT 1, session_info_hash text, snapshot_expires_at timestamptz, source text);
      CREATE TABLE conversation_batches (id bigserial PRIMARY KEY,session_id integer,version text,run_id text,round_id text,digest text,created_at timestamptz,UNIQUE(session_id,digest));
      CREATE TABLE conversation_messages (id bigserial PRIMARY KEY,session_id integer,conversation_seq bigint,history_anchor_seq bigint,
        role text,content text,content_json jsonb,canonical_batch_id bigint,run_id text,round_id text,created_at timestamptz,
        sent_at timestamptz,im_platform_sent_ms bigint,im_event_received_ms bigint,files jsonb,display_timeline jsonb,run_outcome jsonb,covers_until_seq bigint,quoted_text text,platform_user_id text,platform_user_name text,chat_type text,references_json jsonb);
      CREATE TABLE rag_index_jobs (id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation integer NOT NULL,completed_generation integer NOT NULL,attempts integer NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_started_at timestamptz,last_succeeded_at timestamptz,last_error_code text,pending_source_ids json NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type));
      CREATE TABLE agent_usage (user_id uuid, session_id integer, tokens_in integer, tokens_out integer, cache_read integer,
        cache_write integer,cache_round_stats jsonb,model text,provider text,is_byok boolean,tools_used jsonb,scenario text,input_source text,created_at timestamptz)`)
    await pool.query('INSERT INTO users (id) VALUES ($1)', [identity.ownerId])
    await pool.query('INSERT INTO conversation_sessions (id,user_id,last_message_seq,session_context) VALUES (1,$1,1,NULL)', [identity.ownerId])
    const anchor = await pool.query<{ id: string }>(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at,sent_at)
      VALUES (1,1,'user','问题',clock_timestamp(),clock_timestamp()) RETURNING id::text`)
    const first = await createPostgresCurrentTurnReader(pool, anchor.rows[0]!.id, createWebCurrentMessageMaterializer(pool))(identity)
    const prepared = await prepareContext({ ...identity, ...first, history: [], fixedPrefix: [], userTimezone: 'Asia/Shanghai' },
      { digest, nextId: randomUUID, buildRag: async () => ({ tail: [] }), formatMessageTime: formatAgentHistoryMessageTime })
    const firstUserContent = prepared.area.messages[0]?.content
    assert.match(String(firstUserContent), /^【消息时间】/)
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
      const interrupted = { ...checkpoint, status: 'unknown' as const, errorCode: 'tool_result_unknown',
        displayTimeline: [
          { kind: 'assistant' as const, text: '已经生成的回复' },
          { kind: 'tool' as const, toolCallId: 'synthetic-call', toolStatus: 'unknown' },
        ] } as RunCheckpoint<CanonicalRunContext>
      await writer(client, identity, { outcome: 'interruption', context, text: '已经生成的回复' }, interrupted)
      const interruptedRows = (await client.query('SELECT role, content, run_id, run_outcome, display_timeline FROM conversation_messages ORDER BY conversation_seq')).rows
      assert.deepEqual(interruptedRows, [
        { role: 'user', content: '问题', run_id: identity.runId, run_outcome: { status: 'failed', runId: identity.runId, errorCode: 'tool_result_unknown' }, display_timeline: null },
        { role: 'assistant', content: '已经生成的回复', run_id: identity.runId, run_outcome: null, display_timeline: interrupted.displayTimeline },
      ])
      await client.query('ROLLBACK')
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
      const continuation = { ...identity, runId: 'synthetic-next-run' }
      const persisted = await createPostgresCanonicalHistoryReader(pool).read(continuation)
      const ordered = selectSessionHistory(continuation, persisted.rows, persisted.baselineSeq).rows
      assert.deepEqual(ordered.slice(0, 2).map(row => row.content), ['上下文', '问题'])
      const restored = restoreHistoryForRequest(ordered[1]!, {
        userTimezone: 'Asia/Shanghai', formatMessageTime: formatAgentHistoryMessageTime,
      })
      assert.equal(restored?.content, firstUserContent)
      await client.query('BEGIN')
      await assert.rejects(writer(client, identity, { outcome: 'success', context, text: '回答' }, checkpoint), /已提交/)
      await client.query('ROLLBACK')
      await pool.query(`UPDATE conversation_sessions SET snapshot_hash='snapshot',context_epoch=1 WHERE id=1`)
      const covered = await pool.query<{ id: string }>(`SELECT id::text FROM conversation_messages WHERE session_id=1
        ORDER BY coalesce(history_anchor_seq,conversation_seq), (history_anchor_seq IS NULL), conversation_seq LIMIT 2`)
      // 界面时间线没有模型正文：落在同一锚点中也不能让合法摘要失效。
      await pool.query(`INSERT INTO conversation_messages (session_id,conversation_seq,history_anchor_seq,role,content,display_timeline)
        VALUES (1,5,1,'assistant','','[]'::jsonb)`)
      await pool.query('UPDATE conversation_sessions SET last_message_seq=5 WHERE id=1')
      const nextIdentity = { ...identity, runId: 'second-run' }
      const snapshot = { ownerId: identity.ownerId, sessionId: '1', contextEpoch: 1, context: {}, snapshotHash: 'snapshot',
        sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }
      const emptyArea = new MessageArea({ digest, nextId: randomUUID })
      const compactContext = { ...context, identity: nextIdentity, continuationRef: null, prepared: { area: emptyArea.snapshot() },
        historyBaseline: { baselineSeq: 0, baselineHash: null, snapshotHash: 'snapshot' },
        sourceEffects: { sessionSnapshot: { state: snapshot } }, compactions: [
          { id: 'compact-1', result: { changed: true, coversUnpersisted: false,
            coversUntilMessageIds: [covered.rows[1]!.id], messages: [{ role: 'user', content: formatCompactedSummary('旧摘要') }] } },
          { id: 'compact-2', result: { changed: true, coversUnpersisted: false,
            coversUntilMessageIds: [covered.rows[0]!.id], messages: [{ role: 'user', content: formatCompactedSummary('历史摘要') }] } },
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
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM conversation_messages
        WHERE conversation_seq=5 AND display_timeline IS NOT NULL`)).rows[0].n), 1)
      // 十个最近单元保留原文，前缀不吻合时对已提交历史单独生成摘要。
      const inserted = await client.query<{ id: string; conversation_seq: string }>(`
        INSERT INTO conversation_messages (session_id,conversation_seq,role,content)
        SELECT 1, n, 'user', '历史-' || n FROM generate_series(7,22) AS n RETURNING id::text,conversation_seq::text`)
      await client.query('UPDATE conversation_sessions SET last_message_seq=22 WHERE id=1')
      const snapshotRow = (await client.query('SELECT * FROM conversation_sessions WHERE id=1')).rows[0]
      const postCommitContext = { ...compactContext, historyBaseline: {
        baselineSeq: 1, baselineHash: snapshotRow.baseline_message_hash, snapshotHash: snapshotRow.snapshot_hash,
      }, sourceEffects: { sessionSnapshot: { state: {
        ...snapshot, baselineMessageSeq: 1, context: snapshotRow.session_context, snapshotHash: snapshotRow.snapshot_hash,
        contextEpoch: snapshotRow.context_epoch, snapshotExpiresAt: new Date(snapshotRow.snapshot_expires_at).getTime(),
      } } } } as CanonicalRunContext
      let requests = 0
      const port = { async summarize(input: { history: readonly { content: unknown }[] }) {
        requests++
        const texts = input.history.map(message => message.content)
        assert.ok(texts.includes('历史-11'))
        assert.ok(!texts.includes('历史-12'))
        return '重新生成的合成摘要'
      } }
      const anchorId = Number(inserted.rows.find(row => row.conversation_seq === '22')!.id)
      assert.equal(await persistRunCompaction(pool, postCommitContext, port, anchorId), true)
      assert.equal(await persistRunCompaction(pool, postCommitContext, port, anchorId), false)
      assert.equal(requests, 1)
      assert.equal(Number((await pool.query('SELECT baseline_message_seq FROM conversation_sessions WHERE id=1')).rows[0].baseline_message_seq), 11)
      const refreshed = (await pool.query("SELECT content,covers_until_seq FROM conversation_messages WHERE session_id=1 AND role='summary'")).rows[0]
      assert.equal(refreshed.content, '重新生成的合成摘要')
      assert.equal(Number(refreshed.covers_until_seq), 11)
      assert.equal((await pool.query('SELECT 1 FROM conversation_messages WHERE session_id=1 AND conversation_seq BETWEEN 12 AND 22')).rowCount, 11)
      const latestSnapshot = (await client.query('SELECT * FROM conversation_sessions WHERE id=1')).rows[0]
      const reuseContext = { ...postCommitContext, historyBaseline: {
        baselineSeq: 11, baselineHash: latestSnapshot.baseline_message_hash, snapshotHash: latestSnapshot.snapshot_hash,
      }, sourceEffects: { sessionSnapshot: { state: {
        ...snapshot, baselineMessageSeq: 11, context: latestSnapshot.session_context, snapshotHash: latestSnapshot.snapshot_hash,
        contextEpoch: latestSnapshot.context_epoch, snapshotExpiresAt: new Date(latestSnapshot.snapshot_expires_at).getTime(),
      } } }, compactions: [{ id: 'reuse', result: { changed: true, coversUnpersisted: false,
        coversUntilMessageIds: [inserted.rows.find(row => row.conversation_seq === '12')!.id],
        messages: [{ role: 'user', content: formatCompactedSummary('精确复用摘要') }],
      } }] } as unknown as CanonicalRunContext
      const laterAnchor = await client.query<{ id: string }>(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content)
        VALUES (1,24,'user','下一轮问题') RETURNING id::text`)
      await client.query('UPDATE conversation_sessions SET last_message_seq=24 WHERE id=1')
      assert.equal(await persistRunCompaction(pool, reuseContext, { async summarize() {
        assert.fail('同一前缀应直接复用摘要')
      } }, Number(laterAnchor.rows[0]!.id)), true)
      const reused = (await pool.query("SELECT content,covers_until_seq FROM conversation_messages WHERE session_id=1 AND role='summary'")).rows[0]
      assert.equal(reused.content, '精确复用摘要')
      assert.equal(Number(reused.covers_until_seq), 12)
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

test('基线或覆盖范围变化时保留旧历史并提交最终回复', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  const area = new MessageArea({ digest, nextId: randomUUID })
  const context = { identity, modelIdentity: 'model', continuationRef: null, prepared: { area: area.snapshot() },
    historyBaseline: { baselineSeq: 1, baselineHash: 'old', snapshotHash: 'snapshot' },
    sourceEffects: { sessionSnapshot: { state: { snapshotHash: 'snapshot', contextEpoch: 2 } } },
    providerCacheAnchor: { anchor: { baseline_digest: 'stale' } },
    compactions: [{ id: 'compaction', result: { changed: true, coversUnpersisted: false, coversUntilMessageIds: ['2'] } }] } as unknown as CanonicalRunContext
  const checkpoint = { identity, status: 'completed', files: [], displayTimeline: [],
    totalUsage: { input: 9, output: 3, cacheRead: 0, cacheWrite: 0, contextInput: null }, providerRounds: [] } as unknown as RunCheckpoint<CanonicalRunContext>
  const writer = createCanonicalHistoryWriter(async () => ({ defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }))
  for (const conflict of ['baseline', 'prefix', 'anchor', 'database'] as const) {
    const queries: { sql: string; args: unknown[] }[] = []
    const client = { query: async (sql: string, args: unknown[] = []) => {
      queries.push({ sql, args })
      if (sql.includes('last_message_seq::text')) return { rows: [{ last_message_seq: '3' }] }
      if (sql.includes('AS baseline')) return { rows: [{ baseline: conflict === 'baseline' ? '3' : '1',
        baseline_hash: 'old', snapshot_hash: 'snapshot', context_epoch: 2 }] }
      if (sql.includes('AS effective')) {
        if (conflict === 'database') throw new Error('合成数据库故障')
        return { rows: conflict === 'prefix' ? [{ id: '3', effective: '2' }]
          : [{ id: '2', effective: '2' }, { id: '3', effective: '2' }] }
      }
      if (sql.includes('FROM users u')) return { rows: [{ token_limit_6h: null }] }
      return { rows: [], rowCount: 1 }
    } } as unknown as import('pg').PoolClient
    const result = writer(client, identity, { outcome: 'success', context, text: '最终回复' }, checkpoint)
    if (conflict === 'database') {
      await assert.rejects(result, /合成数据库故障/)
      assert.equal(queries.some(({ sql }) => sql.includes("'finalize-v1'")), false)
      continue
    }
    await result
    assert.equal(queries.filter(({ sql, args }) => sql.includes('INSERT INTO conversation_messages') && args.includes('最终回复')).length, 1)
    assert.equal(queries.filter(({ sql }) => sql.includes("'finalize-v1'")).length, 1)
    assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO agent_usage')).length, 1)
    assert.equal(queries.some(({ sql }) => /DELETE FROM conversation_messages|SET baseline_message_seq|provider_cache_anchor|covers_until_seq/.test(sql)), false)
  }
})

test('摘要基线指纹与 Python 合成输入的完整 SHA-256 一致', () => {
  assert.equal(canonicalBaselineHash([
    { id: '1', role: 'user', content: '合成问题', content_json: null },
    { id: '2', role: 'assistant', content: '', content_json: [{ type: 'text', text: '合成答案' }] },
  ]), 'dc0993323646652b369072747378f6f0b3545996f5215b23ade586766fb2f6bd')
})

test('仅供本次请求的摘要不会阻止保存回复，也不会推进持久水位', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  const area = new MessageArea({ digest, nextId: randomUUID })
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null }
  const writer = createCanonicalHistoryWriter(async () => ({ defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'model', provider: 'provider', isByok: false }))
  for (const coversUnpersisted of [true, undefined]) {
    const queries: string[] = []
    const client = { query: async (sql: string) => {
      queries.push(sql)
      return { rows: [{ last_message_seq: '3' }], rowCount: 1 }
    } } as unknown as import('pg').PoolClient
    const context = { identity, modelIdentity: 'model', continuationRef: null, prepared: { area: area.snapshot() },
      providerCacheAnchor: { anchor: { baseline_digest: 'request-only' } },
      compactions: [
        { id: 'transient', result: { changed: true, coversUnpersisted, coversUntilMessageIds: ['2'] } },
        { id: 'later', result: { changed: true, coversUnpersisted: false, coversUntilMessageIds: ['3'] } },
      ] } as unknown as CanonicalRunContext
    const checkpoint = { identity, status: 'completed', files: [], displayTimeline: [], totalUsage: usage, providerRounds: [] } as unknown as RunCheckpoint<CanonicalRunContext>
    await writer(client, identity, { outcome: 'success', context, text: '回复' }, checkpoint)
    assert.ok(queries.some(sql => sql.includes('INSERT INTO conversation_messages')))
    assert.equal(queries.some(sql => /baseline_message_seq|provider_cache_anchor|covers_until_seq/.test(sql)), false)
  }
})
