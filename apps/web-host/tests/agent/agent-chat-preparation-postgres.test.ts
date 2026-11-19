import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { registerAgentRunStartupLocked } from '../../src/modules/agent-sessions/persistence/agent-run-startup-postgres.js'
import { createPostgresAgentChatPreparation, createPostgresWebChatSession, type AgentChatPreparationPorts } from '../../src/modules/agent-sessions/persistence/agent-chat-preparation.js'
import { enqueueAgentRunLocked } from '../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('隔离 PG 新会话和问候先于用户消息提交，附件或队列失败回滚所有数据', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `chat_prepare_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL, title text NOT NULL, title_locked boolean NOT NULL, summary text NOT NULL, source text NOT NULL, context_epoch integer NOT NULL, baseline_message_seq bigint NOT NULL, last_message_seq bigint NOT NULL, execution_state text NOT NULL, pending_message_count integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
      CREATE TABLE conversation_messages (id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id), conversation_seq bigint NOT NULL, role text NOT NULL, content text NOT NULL, client_message_id text, files json, references_json json, content_json json, created_at timestamptz NOT NULL, sent_at timestamptz NOT NULL, UNIQUE(session_id, conversation_seq));
      CREATE TABLE rag_index_jobs (id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation integer NOT NULL,completed_generation integer NOT NULL,attempts integer NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_started_at timestamptz,last_succeeded_at timestamptz,last_error_code text,pending_source_ids json NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type));
      CREATE TABLE claims (message_id integer REFERENCES conversation_messages(id));
      CREATE TABLE agent_run_startups (user_id uuid NOT NULL,session_id integer NOT NULL,run_id text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX uq_selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected'`)
    let fail = ''
    const ports: AgentChatPreparationPorts = {
      createSession: createPostgresWebChatSession,
      registerStartup: registerAgentRunStartupLocked,
      async enqueueDispatch(client, identity, input, ttl) { await enqueueAgentRunLocked(client, 'synthetic-secret', identity, input, ttl); if (fail === 'dispatch') throw new Error('调度失败') },
      async resolveAttachments() { return { cards: [{ attach_id: 'synthetic' }], attachIds: ['synthetic'] } },
      async resolveReferences() { return null },
      async claimAttachments(client, _owner, id) { await client.query('INSERT INTO claims VALUES ($1)', [id]); if (fail === 'attachment') throw new Error('附件失效') },
      async bindQueue() { if (fail === 'queue') throw new Error('队列冲突') },
    }
    const prepare = createPostgresAgentChatPreparation(pool, ports)
    const owner = randomUUID()
    // 生产身份行也是Web/IM创建的共同串行点；只创建本随机schema的合成owner。
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
    await pool.query('INSERT INTO users(id) VALUES($1)',[owner])
    const result = await prepare(owner, { message: '测试', greeting: '  欢迎  ', client_message_id: 'client-1' }, 'run-1', { mode: 'direct' })
    const session = (await pool.query('SELECT * FROM conversation_sessions WHERE id = $1', [result.sessionId])).rows[0]
    assert.equal(session.title, '测试'); assert.equal(session.source, 'web'); assert.equal(session.context_epoch, 1); assert.equal(Number(session.last_message_seq), 2)
    const messages = (await pool.query('SELECT id, role, content, conversation_seq, client_message_id FROM conversation_messages ORDER BY conversation_seq')).rows
    assert.deepEqual(messages.map(row => [row.role, row.content, Number(row.conversation_seq)]), [['assistant', '欢迎', 1], ['user', '测试', 2]])
    assert.equal(messages[1].id, result.userMessageId); assert.equal(messages[1].client_message_id, 'client-1')
    const firstJob = (await pool.query(`SELECT source_id,operation,status,generation,pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [owner])).rows[0]
    assert.deepEqual(firstJob, { source_id: '', operation: 'refresh', status: 'queued', generation: 1, pending_source_ids: [] })
    for (fail of ['attachment', 'queue']) {
      await assert.rejects(prepare(owner, { message: '回滚' }, `run-${fail}`, { mode: 'direct' }))
      assert.equal(Number((await pool.query('SELECT count(*) FROM conversation_sessions')).rows[0].count), 1)
      assert.equal(Number((await pool.query('SELECT count(*) FROM conversation_messages')).rows[0].count), 2)
      assert.equal(Number((await pool.query('SELECT count(*) FROM claims')).rows[0].count), 1)
      assert.equal(Number((await pool.query('SELECT count(*) FROM agent_run_startups')).rows[0].count), 1)
      assert.equal(Number((await pool.query(`SELECT generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [owner])).rows[0].generation), 1)
    }
    fail = ''
    const send = () => prepare(owner, { session_id: result.sessionId, message: '并发' }, 'same-run', { mode: 'direct' })
    const outcomes = await Promise.allSettled([send(), send()])
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(Number((await pool.query('SELECT count(*) FROM conversation_messages')).rows[0].count), 3)
    assert.equal(Number((await pool.query('SELECT count(*) FROM agent_run_startups')).rows[0].count), 2)
    assert.equal(Number((await pool.query(`SELECT generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [owner])).rows[0].generation), 2)
    fail = 'dispatch'
    await assert.rejects(prepare(owner, { session_id: result.sessionId, message: '事务失败' }, 'dispatch-failure', { mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60 }))
    assert.equal(Number((await pool.query('SELECT count(*) FROM conversation_messages')).rows[0].count), 3)
    assert.equal(Number((await pool.query('SELECT count(*) FROM agent_run_dispatch')).rows[0].count), 0)
    fail = ''
    const admitted = await prepare(owner, { session_id: result.sessionId, message: '持久入队' }, 'dispatch-success', { mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60 })
    assert.ok(admitted.userMessageId)
    assert.equal((await pool.query('SELECT state FROM agent_run_dispatch')).rows[0].state, 'selected')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
