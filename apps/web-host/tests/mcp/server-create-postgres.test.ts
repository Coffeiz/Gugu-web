import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify from 'fastify'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createMcpServerCreator } from '@gugu/core/mcp/server-create'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpManagementCreateOperations, createMcpManagementEditOperations, createMcpManagementTool, createToolRegistry } from '@gugu/core/tools'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../src/modules/agent-sessions/tools/agent-confirmation.js'
import { createPostgresTrustedIntentStore } from '../../src/modules/agent-sessions/persistence/agent-trusted-intent-postgres.js'
import { createTrustedPromptDescriptions } from '../../src/modules/agent-sessions/persistence/agent-trusted-prompt-descriptions.js'
import { createAgentInteractionDescription } from '@gugu/core/agent'
import { createPostgresInteractionActivator } from '../../src/modules/agent-sessions/persistence/agent-interaction-activate-postgres.js'
import { createPostgresSecretInteraction } from '../../src/modules/agent-sessions/persistence/agent-secret-interaction-postgres.js'
import { createInteractionResumeEnqueuer, claimInteractionResumeLocked } from '../../src/modules/agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { withPostgresTransaction } from '../../src/adapters/database/postgres-transaction.js'
import { createAgentSecretInteractionService, registerAgentSecretInteractionRoutes } from '../../src/modules/agent-sessions/agent-secret-interaction-route.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('MCP 创建限定 owner、仅保存信封密文并失效旧 Python 工具快照', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `gugu_mcp_create_${randomUUID().replaceAll('-', '')}`
  const owner = randomUUID(), foreign = randomUUID(), admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const runtime = await createPostgresRuntime({ url: databaseUrl!, schema })
  try {
    await pool.query(`CREATE TABLE user_mcp_servers (
      id uuid PRIMARY KEY,user_id uuid NOT NULL,scope text NOT NULL,name text NOT NULL,transport text NOT NULL,
      endpoint text NOT NULL,encrypted_endpoint text NOT NULL,endpoint_nonce text NOT NULL,encrypted_endpoint_key text NOT NULL,
      endpoint_key_version integer NOT NULL,command text NOT NULL,auth_mode text NOT NULL,
      encrypted_headers text NOT NULL,headers_nonce text NOT NULL,encrypted_headers_key text NOT NULL,headers_key_version integer NOT NULL,
      encrypted_query_params text NOT NULL,query_params_nonce text NOT NULL,encrypted_query_params_key text NOT NULL,query_params_key_version integer NOT NULL,
      credential_slots jsonb NOT NULL,encrypted_credentials text NOT NULL,credentials_nonce text NOT NULL,
      encrypted_credentials_key text NOT NULL,credentials_key_version integer NOT NULL,enabled boolean NOT NULL,
      confirm_mode text NOT NULL,timeout_seconds integer NOT NULL,tool_allowlist jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
      UNIQUE(user_id,scope,name)
    ); CREATE TABLE user_mcp_tool_schema_snapshots(user_id uuid PRIMARY KEY,config_digest text NOT NULL,schemas jsonb NOT NULL,refreshed_at timestamptz NOT NULL)`)
    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp()),($4,$2,$3,clock_timestamp())', [owner, 'old-owner-snapshot', '[]', foreign])
    const create = createMcpServerCreator(runtime.db, {
      maxServersPerUser: 1,
      id: () => '00000000-0000-7000-8000-000000000001',
      async encrypt(plaintext) {
        return { ciphertext: `cipher:${plaintext}`, nonce: 'synthetic-nonce', encryptedDataKey: 'synthetic-wrapped-key', keyVersion: 1 }
      },
    })
    const input = {
      name: 'weather', transport: 'http' as const, endpoint: 'https://mcp.example/rpc?key={{secret:api}}', command: '',
      credential_slots: [{ id: 'api', label: 'API key', target: 'query' as const, name: 'key', prefix: '' }],
      credential_values: { api: 'synthetic-secret' }, enabled: true, confirm_mode: 'confirm_all', timeout_seconds: 30,
      tool_allowlist: ['forecast'],
    }
    const result = await create(owner, input)
    assert.equal(result.name, 'weather')
    assert.equal(result.endpoint, input.endpoint)
    assert.deepEqual(result.credential_values, input.credential_values)
    assert.deepEqual(result.credential_state, { configured: true, slot_ids: ['api'] })
    const stored = (await pool.query('SELECT * FROM user_mcp_servers WHERE user_id=$1', [owner])).rows[0]
    assert.equal(stored.endpoint, '')
    assert.equal(stored.encrypted_endpoint, `cipher:${input.endpoint}`)
    assert.equal(stored.encrypted_credentials, 'cipher:{"api":"synthetic-secret"}')
    assert.equal(stored.encrypted_endpoint.includes('synthetic-secret'), false)
    assert.equal((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots ORDER BY user_id')).rowCount, 1)
    assert.equal((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows[0].user_id, foreign)

    await assert.rejects(create(owner, { ...input, name: 'second', endpoint: 'https://mcp.example/other' }), (error: unknown) =>
      (error as { code?: string }).code === 'invalid_request')
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_servers')).rows[0].count, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_tool_schema_snapshots')).rows[0].count, 1)

    await pool.query(`${tablesSql('postgres').receipts};
      CREATE TABLE users(id uuid PRIMARY KEY,security_version integer,is_active boolean,account_status text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,
        ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text);
      CREATE TABLE agent_interaction_bindings(user_id uuid,session_id integer,run_id text,prompt_id integer PRIMARY KEY,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text,
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP, completed_at timestamptz, claim_token text, claim_expires_at timestamptz);
      CREATE TABLE interaction_prompts(id integer GENERATED BY DEFAULT AS IDENTITY,user_id uuid,session_id integer,kind text,status text,expires_at timestamptz,
        schema_json jsonb,title text,body text,created_at timestamptz,resolved_at timestamptz);
      CREATE TABLE interaction_actions(prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz,token_hash text,created_at timestamptz);
      CREATE TABLE mcp_secret_inputs(prompt_id integer,user_id uuid,session_id integer,status text,encrypted_payload text,payload_nonce text,encrypted_data_key text)`)
    const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-mcp-run' }
    const version = 'a'.repeat(64)
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: version } }
    await pool.query("INSERT INTO users VALUES ($1,1,true,'active')", [owner])
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2)', [owner, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [owner, identity.runId, lease.token])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,$2,CURRENT_TIMESTAMP+interval '5 minutes')", [owner, identity.runId])
    const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return version } })
    const intents = createPostgresTrustedIntentStore(() => 'synthetic-mcp-master', 1)
    const confirmation = createWebAgentToolConfirmation({ pool, lease, action: 'add_mcp_server', intents, ...authority,
      async describe(_binding, snapshot) {
        assert.match(snapshot.displaySummary ?? '', /备用工具.*https:\/\/example\.invalid/u)
        assert.doesNotMatch(snapshot.displaySummary ?? '', /private-route/u)
        return { summary: snapshot.displaySummary! }
      } })
    let defaultTimeout = 48, failSeal = false, failIntent = false
    const add = createMcpManagementCreateOperations(runtime, {
      settings: () => ({ default_timeout_seconds: defaultTimeout, max_tools_per_server: 8, max_servers_per_user: 2 }),
      id: randomUUID, validateEndpoint: endpoint => endpoint,
      async encrypt(endpoint) {
        if (failSeal) throw new Error('合成加密失败')
        return { ciphertext: Buffer.from(endpoint).toString('base64'), nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 }
      },
      confirmation,
      async stageCredential(tx, candidate, request, serverId) {
        await intents.stageMcpCredential(tx, candidate, request, serverId)
        if (failIntent) throw new Error('合成意图提交失败')
      },
      async authorize(tx, candidate, signal) { return (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${version}`) === true },
    })
    const list = createMcpServerConfigLister(runtime.db)
    const editConfirmation = createWebAgentToolConfirmation({ pool, lease, action: 'update_mcp_server', intents, ...authority,
      async describe(_binding, snapshot) {
        assert.match(snapshot.displaySummary ?? '', /清除旧凭据/u)
        return { summary: snapshot.displaySummary! }
      } })
    let invalidations = 0
    const crypto = {
      async encrypt(value: string) {
        return { ciphertext: Buffer.from(value).toString('base64'), nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 }
      },
      async decrypt(value: { ciphertext: string }) { return Buffer.from(value.ciphertext, 'base64').toString() },
    }
    const edit = createMcpManagementEditOperations(runtime, {
      decrypt: crypto.decrypt,
      async authorize(tx, candidate, signal) { return (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${version}`) === true },
      async afterCommit() { invalidations++ },
      update: { crypto, maxTools: 8, validateEndpoint: endpoint => endpoint, confirmation: editConfirmation,
        credential: { id: randomUUID, async stage(tx, candidate, request, serverId) {
          await intents.stageMcpCredential(tx, candidate, request, serverId)
          if (failIntent) throw new Error('合成意图提交失败')
        } },
      },
    })
    const { tools } = createToolRegistry({ authorize: async candidate => candidate.ownerId === owner,
      tools: [createMcpManagementTool({ list, decrypt: crypto.decrypt, enabled: () => true, state: () => ({ state: 'unloaded', loaded_tool_count: 0 }) }, undefined, edit, add)] })
    const call = { id: 'add', name: 'manage_mcp_servers', input: { action: 'add', server_name: '备用工具', endpoint: 'https://example.invalid/private-route',
      credential_slots: [{ id: 'token', label: '连接令牌', target: 'header', parameter_name: 'Authorization', prefix: 'Bearer ' }] } }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行进程') } }
    const missing = await tools.dispatch({ ...call, input: { ...call.input, credential_values: { token: 'synthetic-forbidden' } } }, scope)
    assert.ok(missing.kind === 'completed' && !missing.successful)
    const waiting = await tools.dispatch(call, scope)
    assert.equal(waiting.kind, 'waiting')
    if (waiting.kind !== 'waiting') throw new Error('没有建立待确认交互')
    assert.equal((await list(owner)).length, 1)
    async function approve(promptId: number, interactionId: string, toolCallId: string) {
      const receiptId = `web-prompt:${promptId}`
      await pool.query('INSERT INTO agent_interaction_bindings VALUES ($1,1,$2,$3,$4,$5)', [owner, identity.runId, promptId, interactionId, toolCallId])
      await pool.query('INSERT INTO agent_interaction_resumes(user_id,session_id,run_id,prompt_id,interaction_id,receipt) VALUES ($1,1,$2,$3,$4,$5)', [owner, identity.runId, promptId, interactionId, receiptId])
      await pool.query('INSERT INTO agent_run_interaction_receipts VALUES ($1,1,$2,$3)', [owner, identity.runId, receiptId])
      await pool.query("INSERT INTO interaction_prompts(id,user_id,session_id,kind,status,expires_at,schema_json) VALUES ($1,$2,1,'confirm','resolved',CURRENT_TIMESTAMP+interval '2 minutes',$3)", [promptId, owner,
        { context: { confirm_code: 'synthetic-code' }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } }])
      await pool.query("INSERT INTO interaction_actions(prompt_id,status,option_id,action_type,context_json,expires_at) VALUES ($1,'consumed','confirm','confirm',$2,CURRENT_TIMESTAMP+interval '2 minutes')",
        [promptId, { tool_call_id: toolCallId, tool_name: call.name, confirm_code: 'synthetic-code' }])
      return { ...scope, resolution: { interactionId, receiptId, status: 'confirmed' as const, value: null } }
    }
    const confirmed = await approve(9, waiting.interaction.id, call.id)
    const forged = await tools.dispatch(call, { ...confirmed, resolution: { ...confirmed.resolution, receiptId: 'forged' } })
    assert.ok(forged.kind === 'completed' && !forged.successful)
    defaultTimeout = 50
    const changed = await tools.dispatch(call, confirmed)
    assert.ok(changed.kind === 'completed' && !changed.successful)
    defaultTimeout = 48
    failSeal = true
    assert.equal((await tools.dispatch(call, confirmed)).kind, 'unknown')
    assert.equal((await list(owner)).length, 1)
    assert.equal((await pool.query('SELECT * FROM agent_interaction_intents')).rowCount, 1)
    failSeal = false
    failIntent = true
    assert.equal((await tools.dispatch(call, confirmed)).kind, 'unknown')
    assert.equal((await list(owner)).length, 1)
    assert.equal((await pool.query('SELECT * FROM agent_interaction_intents')).rowCount, 1)
    failIntent = false
    const resultAdd = await tools.dispatch(call, confirmed)
    assert.ok(resultAdd.kind === 'waiting' && resultAdd.interaction.kind === 'credential')
    const configured = (await list(owner)).find(row => row.name === '备用工具')!
    assert.equal(configured.timeout_seconds, 48)
    assert.equal(configured.encrypted_credentials, '')
    assert.deepEqual(await tools.reconcile(call, { ...identity, roundId: scope.roundId }), resultAdd)
    assert.deepEqual(await tools.dispatch(call, confirmed), resultAdd)
    const storedReceipts = (await pool.query("SELECT result_json FROM core_operation_receipts WHERE method='agent.mcp.add'")).rows
    assert.equal(storedReceipts.length, 1)
    assert.doesNotMatch(JSON.stringify(storedReceipts), /private-route|credential_values|prefix|Bearer/)
    assert.equal((await pool.query('SELECT * FROM agent_interaction_intents')).rowCount, 1)
    const activator = createPostgresInteractionActivator(pool, createAgentInteractionDescription(createTrustedPromptDescriptions({
      loadIntent: intents.loadIntent, async createConfirmation() { throw new Error('凭据阶段不申请确认码') },
      filesystemAuthorizationEnabled: () => false,
    })))
    let pending = resultAdd.interaction
    await activator.activate(identity, pending, scope.signal)
    await activator.activate(identity, pending, scope.signal)
    const forms = (await pool.query("SELECT id,schema_json FROM interaction_prompts WHERE kind='form'")).rows
    assert.equal(forms.length, 1)
    assert.equal((await pool.query('SELECT * FROM agent_interaction_intents')).rowCount, 0)
    const form = forms[0]!
    assert.deepEqual(form.schema_json.secret_fields, [{ name: 'token', label: '连接令牌', type: 'secret' }])
    assert.match(form.schema_json.context.secret_target.configuration_version, /^[a-f0-9]{64}$/u)

    const consume = createPostgresSecretInteraction(pool, {
      encrypt(values) { return { ciphertext: Buffer.from(JSON.stringify(values)).toString('base64'), nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 } },
      enqueue: createInteractionResumeEnqueuer({ async readForUpdate(_client, candidate) {
        assert.deepEqual(candidate, identity)
        return { status: 'waiting', pending } as never
      } }),
      async invalidate(client, id) { await client.query('DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=$1', [id]) },
    })
    await assert.rejects(consume(foreign, form.id, { token: 'synthetic-input-only' }), /不存在/)
    await pool.query("UPDATE user_mcp_servers SET name='变更中' WHERE id=$1", [configured.id])
    await assert.rejects(consume(owner, form.id, { token: 'synthetic-input-only' }), /配置已变化/)
    assert.equal((await list(owner)).find(row => row.id === configured.id)?.encrypted_credentials, '')
    await pool.query('UPDATE user_mcp_servers SET name=$2 WHERE id=$1', [configured.id, configured.name])
    const app = Fastify()
    registerAgentSecretInteractionRoutes(app, { requireUser: async () => {}, userIdFromRequest: () => owner,
      service: createAgentSecretInteractionService({ consume, async wake() {}, diagnose() {} }) })
    try {
      const submitted = await app.inject({ method: 'POST', url: `/api/v1/agent/interactions/${form.id}/secrets`,
        payload: { values: { token: 'synthetic-input-only' } } })
      assert.equal(submitted.statusCode, 200)
      assert.doesNotMatch(submitted.body, /synthetic-input-only/)
    } finally { await app.close() }
    assert.equal((await list(owner)).find(row => row.id === configured.id)?.encrypted_credentials,
      Buffer.from('{"token":"synthetic-input-only"}').toString('base64'))
    await assert.rejects(consume(owner, form.id, { token: 'another-value' }), /过期/)
    const claimed = await withPostgresTransaction(pool, client => claimInteractionResumeLocked(client, identity))
    assert.equal(claimed?.resolution.status, 'answered')
    assert.equal(claimed?.resolution.interactionId, pending.id)
    assert.doesNotMatch(JSON.stringify(claimed), /synthetic-input-only|another-value/)

    const updateCall = { id: 'rotate', name: call.name, input: { action: 'update', server_id: configured.id,
      credential_slots: [{ id: 'next', label: '新令牌', target: 'header', parameter_name: 'X-Token', prefix: 'Synthetic ' }] } }
    const requestUpdate = await tools.dispatch(updateCall, scope)
    assert.ok(requestUpdate.kind === 'waiting' && requestUpdate.interaction.kind === 'confirmation')
    const loadedServer = async () => (await list(owner)).find(row => row.id === configured.id)!
    assert.equal((await loadedServer()).encrypted_credentials, Buffer.from('{"token":"synthetic-input-only"}').toString('base64'))
    const confirmedUpdate = await approve(10, requestUpdate.interaction.id, updateCall.id)
    const tampered = await tools.dispatch({ ...updateCall, input: { ...updateCall.input, credential_slots: [] } }, confirmedUpdate)
    assert.ok(tampered.kind === 'completed' && !tampered.successful)
    failIntent = true
    assert.equal((await tools.dispatch(updateCall, confirmedUpdate)).kind, 'unknown')
    assert.notEqual((await loadedServer()).encrypted_credentials, '')
    assert.equal(invalidations, 0)
    failIntent = false
    const updated = await tools.dispatch(updateCall, confirmedUpdate)
    assert.ok(updated.kind === 'waiting' && updated.interaction.kind === 'credential')
    assert.equal((await loadedServer()).encrypted_credentials, '')
    assert.equal(invalidations, 1)
    assert.deepEqual(await tools.reconcile(updateCall, { ...identity, roundId: scope.roundId }), updated)
    assert.deepEqual(await tools.dispatch(updateCall, confirmedUpdate), updated)
    assert.equal(invalidations, 1)
    pending = updated.interaction
    await activator.activate(identity, pending, scope.signal)
    const updateForm = (await pool.query("SELECT id,schema_json FROM interaction_prompts WHERE kind='form' ORDER BY id DESC LIMIT 1")).rows[0]!
    assert.deepEqual(updateForm.schema_json.secret_fields, [{ name: 'next', label: '新令牌', type: 'secret' }])
    await consume(owner, updateForm.id, { next: 'replacement-private-input' })
    assert.equal((await loadedServer()).encrypted_credentials, Buffer.from('{"next":"replacement-private-input"}').toString('base64'))

    const removeSlots = { ...updateCall, id: 'remove-slots', input: { ...updateCall.input, credential_slots: [] } }
    const removal = await tools.dispatch(removeSlots, scope)
    assert.ok(removal.kind === 'waiting' && removal.interaction.kind === 'confirmation')
    const cleared = await tools.dispatch(removeSlots, await approve(11, removal.interaction.id, removeSlots.id))
    assert.ok(cleared.kind === 'completed' && cleared.successful)
    assert.deepEqual((await loadedServer()).credential_slots, [])
    assert.equal((await loadedServer()).encrypted_credentials, '')
    assert.doesNotMatch(JSON.stringify((await pool.query("SELECT result_json FROM core_operation_receipts WHERE method='agent.mcp.update'")).rows),
      /private-route|replacement-private-input|credential_values|prefix|Synthetic /u)
    assert.equal(invalidations, 2)

    const raceCreator = createMcpServerCreator(runtime.db, { maxServersPerUser: 1, id: randomUUID,
      async encrypt(endpoint) { return { ciphertext: Buffer.from(endpoint).toString('base64'), nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 } } })
    const race = await Promise.allSettled([raceCreator(foreign, { ...input, name: 'first' }), raceCreator(foreign, { ...input, name: 'second' })])
    assert.equal(race.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal((await list(foreign)).length, 1)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
