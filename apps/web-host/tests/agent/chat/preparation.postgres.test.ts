import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { migratePostgres } from '@gugu/database/postgres'
import { registerAgentRunStartupLocked } from '../../../src/modules/agent/run/start.js'
import { createPostgresAgentChatPreparation, createPostgresWebChatSession, type AgentChatPreparationPorts } from '../../../src/modules/agent/chat/prepare.js'
import { decryptAgentDispatchInput, enqueueAgentRunLocked } from '../../../src/modules/agent/run/dispatch.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('隔离 PG 新会话和问候先于用户消息提交，附件或队列失败回滚所有数据', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `chat_prepare_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    await pool.query('CREATE TABLE claims (message_id integer REFERENCES conversation_messages(id))')
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
    await pool.query("INSERT INTO users(id,username,email,hashed_password) VALUES($1,'synthetic','synthetic@example.test','synthetic')",[owner])
    const firstInput = { message: '测试', greeting: '  欢迎  ', client_message_id: 'client-1' }
    const attempts = await Promise.all([
      prepare(owner, firstInput, 'run-1', { mode: 'direct' }),
      prepare(owner, firstInput, 'retry', { mode: 'direct' }),
    ])
    const result = attempts.find(attempt => attempt.isNew)
    assert.ok(result)
    assert.deepEqual(attempts.find(attempt => !attempt.isNew), { ...result, isNew: false, replay: true })
    await assert.rejects(prepare(owner, { message: '冲突', client_message_id: 'client-1' }, 'conflict', { mode: 'direct' }), { code: 'conflict' })
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
    await assert.rejects(prepare(owner, { session_id: result.sessionId, message: '事务失败', client_message_id: 'retry-after-rollback' }, 'dispatch-failure', { mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60 }))
    assert.equal(Number((await pool.query('SELECT count(*) FROM conversation_messages')).rows[0].count), 3)
    assert.equal(Number((await pool.query('SELECT count(*) FROM agent_run_dispatch')).rows[0].count), 0)
    assert.equal((await pool.query("SELECT 1 FROM agent_chat_receipts WHERE client_id='retry-after-rollback'")).rowCount, 0)
    fail = ''
    const model = { modelIdentity: 'gugu-model-v1.synthetic.payload', accessScopeHash: 'b'.repeat(64) }
    const admitted = await prepare(owner, { session_id: result.sessionId, message: '持久入队', credential_id: 12, client_message_id: 'retry-after-rollback' }, 'dispatch-success', {
      mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60,
      async pin(identity, credentialId) {
        assert.equal(identity.runId, 'dispatch-success')
        assert.equal(credentialId, 12)
        return { ...model, accessVersion: 'c'.repeat(64) }
      },
    })
    assert.ok(admitted.userMessageId)
    const retry = await prepare(owner, { session_id: result.sessionId, message: '持久入队', credential_id: 12, client_message_id: 'retry-after-rollback' }, 'retry-run', {
      mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60,
      async pin() { assert.fail('重放不得重新冻结模型') },
    })
    assert.equal(retry.runId, admitted.runId)
    assert.equal(retry.userMessageId, admitted.userMessageId)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM agent_run_dispatch')).rows[0].count, 1)

    const { state, nonce, payload } = (await pool.query('SELECT state,nonce,payload FROM agent_run_dispatch')).rows[0]
    assert.equal(state, 'selected')
    const dispatch = decryptAgentDispatchInput('synthetic-secret', { ownerId: owner, sessionId: String(result.sessionId), runId: 'dispatch-success' }, nonce, payload)
    assert.equal(dispatch.accessVersion, 'c'.repeat(64))
    assert.deepEqual(dispatch.source === 'web' && dispatch.model, model)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
