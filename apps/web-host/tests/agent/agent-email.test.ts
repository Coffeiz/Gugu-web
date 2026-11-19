import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, initializeSqlite, openSqliteRuntime, tablesSql } from '@gugu/core/data'
import { sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { createConfirmationGate, createToolRegistry } from '@gugu/core/tools'
import { createWebAgentEmailTool } from '../../src/modules/agent-sessions/tools/agent-email.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/modules/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../src/modules/agent-sessions/tools/agent-confirmation.js'
import { createPostgresTrustedIntentStore } from '../../src/modules/agent-sessions/persistence/agent-trusted-intent-postgres.js'

test('Web 邮件前置校验使用当前 owner 的地址和附件，缺自定义 HTML 能力时拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-email-host-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'email.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '3', runId: 'run-email' }
    let reads = 0, prepared = 0
    const pool = { async query(query: string, args: unknown[]) {
      reads++
      if (query.includes('FROM files')) {
        assert.deepEqual(args, [identity.ownerId, [91]])
        return { rows: [] }
      }
      assert.equal(args[0], identity.ownerId)
      return { rows: [{ owner_email: 'mock@example.com', smtp_host: null, preferences: {} }] }
    } } as never
    const gate = createConfirmationGate({
      now: () => 1,
      authorize: async () => 'epoch',
      async prepare(binding, snapshot) {
        prepared++
        assert.equal(binding.ownerId, identity.ownerId)
        assert.deepEqual(snapshot.targetRefs, { session: ['3'] })
        assert.equal(snapshot.displaySummary, '将发送纯文本邮件至 m**k@example.com，主题：主题。正文共 2 个字符。邮件发送不可撤回。')
        throw new Error('合成测试不创建交互')
      },
      async inspect() { return null },
      async load() { return null },
    }, { action: 'send_email', purpose: 'action' })
    const tool = createWebAgentEmailTool({
      core: runtime, pool, secretKey: 'synthetic', storageRoot: directory,
      globalSmtp: { host: 'smtp.example.com', port: 465, user: 'sender@example.com', password: '', fromAddress: '', enabled: true, useSsl: true },
      confirmation: { gate, async claim() { assert.fail('未确认不能认领') } },
      async send() { assert.fail('未确认不能发送') },
    })
    const registry = createToolRegistry({ tools: [tool], authorize: async candidate => candidate.ownerId === identity.ownerId })
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('不执行进程') } }
    const dispatch = (input: Record<string, unknown>) => registry.tools.dispatch({
      name: 'send_email', id: 'mail', input: { body: '正文', subject: '主题', ...input },
    }, scope)
    const html = await dispatch({ format: 'html', html: '<p>正文</p>' })
    assert.equal(html.kind === 'completed' && html.successful, false)
    assert.equal(reads, 0)
    const foreign = await dispatch({ to: 'mock@example.com', file_ids: [91] })
    assert.equal(foreign.kind, 'completed')
    assert.equal((foreign.value as { error: string }).error, '附件不存在、已删除或不属于当前用户')
    assert.equal(prepared, 0)
    await dispatch({ format: 'plain' })
    assert.equal(prepared, 1)

    let active = true
    const lease = {
      identity, token: 'test-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) },
    }
    const options = {
      core: runtime, lease, storageRoot: directory, enabled: () => true,
      pool: { async query() { return { rowCount: active ? 1 : 0, rows: [] } } } as never,
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
    }
    const available = async (sendEmail?: typeof tool) =>
      (await createAuthorizedWebAgentProductionRagRunPorts({ ...options, sendEmail }).toolRegistry.capabilities(identity))
        .some(capability => capability.name === 'send_email')
    assert.equal(await available(), false)
    assert.equal(await available(tool), true)
    active = false
    assert.equal(await available(tool), false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('Web 邮件经生产注册器与持久确认发送一次，改主题或伪造回执均拒绝', { skip: !databaseUrl }, async () => {
  const schema = `gugu_agent_email_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'synthetic-email-run' }
  const lease = {
    identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) },
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`${tablesSql('postgres').receipts};
      CREATE TABLE users(id uuid PRIMARY KEY,email text,security_version integer,is_active boolean,account_status text);
      CREATE TABLE user_preferences(user_id uuid,data json);
      CREATE TABLE user_smtp_configs(user_id uuid,host text,port integer,"user" text,password text,from_addr text,use_ssl boolean,enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,
        ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text);
      CREATE TABLE agent_interaction_bindings(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text);
      CREATE TABLE interaction_prompts(id integer,user_id uuid,session_id integer,kind text,status text,expires_at timestamptz,schema_json jsonb);
      CREATE TABLE interaction_actions(prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz)`)
    await pool.query("INSERT INTO users VALUES ($1,'receiver@example.test',1,true,'active')", [identity.ownerId])
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2)', [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId, lease.token])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,$2,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId])
    const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return lease.input.accessVersion } })
    const intents = createPostgresTrustedIntentStore(() => 'synthetic-email-master', 1)
    const confirmation = createWebAgentToolConfirmation({
      pool, lease, action: 'send_email', intents, ...authority,
      async describe(_binding, snapshot) {
        assert.ok(snapshot.displaySummary)
        return { summary: snapshot.displaySummary }
      },
    })
    let sends = 0
    const createRegistry = () => createAuthorizedWebAgentProductionRagRunPorts({
      core, pool, lease, storageRoot: '/synthetic', enabled: () => true,
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      sendEmail: createWebAgentEmailTool({
        core, pool, confirmation, secretKey: 'synthetic-key', storageRoot: '/synthetic', sanitizeHtml: sanitizeEmailHtml,
        globalSmtp: { host: 'smtp.example.test', port: 465, user: 'sender@example.test', password: 'synthetic-smtp-password', fromAddress: '', enabled: true, useSsl: true },
        async send(delivery) {
          sends++
          assert.equal(delivery.toAddress, 'receiver@example.test')
          assert.equal(delivery.message.subject, '合成邮件主题')
          assert.equal(delivery.message.plain, '合成私密正文')
          assert.equal(delivery.message.html, '<p>合成正文</p><img alt="图片">')
        },
      }),
    }).toolRegistry
    const registry = createRegistry()
    const action = 'send_email'
    const call = { id: 'mail', name: action, input: {
      subject: '合成邮件主题', body: '合成私密正文', format: 'html',
      html: '<p onclick="doSomething()">合成正文</p><script>ignored</script><img src="https://example.test/pixel" alt="图片">',
    } }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('邮件不调用沙盒') } }
    const waiting = await registry.tools.dispatch(call, scope)
    assert.ok(waiting.kind === 'waiting', JSON.stringify(waiting))
    assert.equal(sends, 0)
    const interaction = waiting.interaction.id
    const client = await pool.connect()
    try {
      const saved = await intents.loadIntent(client, identity, waiting.interaction)
      assert.ok(saved?.kind === 'confirmation')
      assert.match(saved.summary, /r\*+r@example\.test.*合成邮件主题/u)
      assert.doesNotMatch(JSON.stringify(saved), /合成私密正文|synthetic-smtp-password|receiver@example\.test/u)
    } finally { client.release() }
    const code = 'synthetic-code'
    // 模拟 Web 端提交同意后的投影，可信意图、claim 和收据均使用真实 PostgreSQL。
    await pool.query('INSERT INTO agent_interaction_bindings VALUES ($1,1,$2,9,$3,$4)', [identity.ownerId, identity.runId, interaction, call.id])
    await pool.query("INSERT INTO agent_interaction_resumes VALUES ($1,1,$2,9,$3,'web-prompt:9')", [identity.ownerId, identity.runId, interaction])
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,1,$2,'web-prompt:9')", [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO interaction_prompts VALUES (9,$1,1,'confirm','resolved',CURRENT_TIMESTAMP+interval '2 minutes',$2)", [identity.ownerId,
      { context: { confirm_code: code }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } }])
    await pool.query("INSERT INTO interaction_actions VALUES (9,'consumed','confirm','confirm',$1,CURRENT_TIMESTAMP+interval '2 minutes')",
      [{ tool_call_id: call.id, tool_name: action, confirm_code: code }])
    const resume = { ...scope, resolution: { interactionId: interaction, receiptId: 'web-prompt:9', status: 'confirmed' as const, value: {} } }
    const forged = await registry.tools.dispatch(call, { ...resume, resolution: { ...resume.resolution, receiptId: 'forged' } })
    assert.ok(forged.kind === 'completed' && !forged.successful)
    const altered = await registry.tools.dispatch({ ...call, input: { ...call.input, subject: '改变主题' } }, resume)
    assert.ok(altered.kind === 'completed' && !altered.successful)
    assert.equal(sends, 0)
    const sent = await registry.tools.dispatch(call, resume)
    assert.ok(sent.kind === 'completed' && sent.successful && sent.mutated, JSON.stringify(sent))
    assert.deepEqual(await createRegistry().tools.dispatch(call, resume), { ...sent, mutated: false })
    assert.equal(sends, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_intents')).rows[0].n, 0)
    const receipts = (await pool.query('SELECT result_json FROM core_operation_receipts')).rows
    assert.equal(receipts.length, 2)
    assert.doesNotMatch(JSON.stringify(receipts), /合成私密正文|synthetic-smtp-password|receiver@example\.test/u)
  } finally {
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
