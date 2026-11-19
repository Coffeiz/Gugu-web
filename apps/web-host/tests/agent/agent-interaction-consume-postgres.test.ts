import { encryptByokEnvelope, decryptByokCredential } from '../../src/modules/byok/crypto.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { consumeInteractionAction } from '@gugu/core/agent/interactions/consume-action'
import { processOneInteraction } from '@gugu/core/agent'
import { createPostgresSecretInteraction } from '../../src/modules/agent/interactions/secrets.js'
import { createPostgresInteractionConsumeStore } from '../../src/modules/agent/interactions/consume.js'
import { createInteractionResumeEnqueuer, createPostgresInteractionResumeQueue, deliverInteractionResume } from '../../src/modules/agent/interactions/resume.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('交互消费按 owner 和 token 限制，竞争只提交一次并保护副作用', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_interaction_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 })
  const ownerId = randomUUID(), otherOwnerId = randomUUID()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query('CREATE TABLE interaction_prompts (id integer PRIMARY KEY, user_id text, session_id integer, kind text, status text, expires_at timestamptz, resolved_at timestamptz, schema_json jsonb)')
    await pool.query('CREATE TABLE interaction_actions (id integer PRIMARY KEY, prompt_id integer, token_hash text, action_type text, option_id text, context_json jsonb, status text, expires_at timestamptz, consumed_at timestamptz, consumed_event_id text)')
    await pool.query('CREATE TABLE synthetic_effects (owner_id text)')
    await pool.query('CREATE TABLE user_mcp_servers (id uuid, user_id text, scope text, credential_slots jsonb, encrypted_credentials text, credentials_nonce text, encrypted_credentials_key text, credentials_key_version integer)')
    await pool.query('CREATE TABLE mcp_secret_inputs (prompt_id integer, user_id text, status text, encrypted_payload text, payload_nonce text, encrypted_data_key text)')
    await pool.query('CREATE TABLE agent_run_checkpoints (user_id text, session_id integer, run_id text, status text)')
    await pool.query('CREATE TABLE agent_run_interaction_receipts (user_id text, session_id integer, run_id text, receipt text)')
    await pool.query('CREATE TABLE agent_interaction_bindings (user_id text, session_id integer, run_id text, prompt_id integer PRIMARY KEY, interaction_id text, tool_call_id text)')
    await pool.query('CREATE TABLE agent_interaction_resumes (user_id text, session_id integer, run_id text, prompt_id integer, interaction_id text, receipt text, created_at timestamptz, completed_at timestamptz, claim_token text, claim_expires_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,prompt_id))')
    await pool.query("INSERT INTO interaction_prompts VALUES (1,$1,7,'confirm','active',clock_timestamp()+interval '1 hour',NULL,$2)", [ownerId, JSON.stringify({ options: [{ id: 'confirm', label: '确认' }] })])
    await pool.query("INSERT INTO interaction_actions VALUES (1,1,$1,'choice','confirm',$2,'pending',clock_timestamp()+interval '1 hour',NULL,NULL)", [createHash('sha256').update('synthetic-token').digest('hex'), JSON.stringify({ command_action: 'workspace_delete' })])
    const store = createPostgresInteractionConsumeStore(pool, { async applyCommandAction(client, input) { await client.query('INSERT INTO synthetic_effects VALUES ($1)', [input.ownerId]); return { status: 'confirmed', text: '完成' } }, async redeemConfirmation() { return true } })
    await assert.rejects(consumeInteractionAction(store, { ownerId: otherOwnerId, promptId: 1, token: 'synthetic-token' }), /交互不存在/)
    await assert.rejects(consumeInteractionAction(store, { ownerId, promptId: 1, token: 'wrong-token' }), /动作无效/)
    const attempts = await Promise.allSettled([consumeInteractionAction(store, { ownerId, promptId: 1, token: 'synthetic-token' }), consumeInteractionAction(store, { ownerId, promptId: 1, token: 'synthetic-token' })])
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM synthetic_effects')).rows[0].n), 1)
    assert.equal((await pool.query('SELECT status FROM interaction_prompts')).rows[0].status, 'resolved')
    await pool.query("INSERT INTO interaction_prompts SELECT 2, user_id, session_id, kind, 'active', expires_at, NULL, schema_json FROM interaction_prompts WHERE id = 1")
    await pool.query("INSERT INTO interaction_actions SELECT 2, 2, token_hash, action_type, option_id, context_json, 'pending', expires_at, NULL, NULL FROM interaction_actions WHERE id = 1")
    const failing = createPostgresInteractionConsumeStore(pool, { async applyCommandAction(client) { await client.query("INSERT INTO synthetic_effects VALUES ('rolled-back')"); throw new Error('synthetic failure') }, async redeemConfirmation() { return true } })
    await assert.rejects(consumeInteractionAction(failing, { ownerId, promptId: 2, token: 'synthetic-token' }))
    assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id = 2')).rows[0].status, 'active')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM synthetic_effects')).rows[0].n), 1)
    await pool.query("INSERT INTO interaction_prompts SELECT 3, user_id, session_id, kind, 'active', expires_at, NULL, schema_json FROM interaction_prompts WHERE id = 1")
    await pool.query("INSERT INTO interaction_actions SELECT 3, 3, token_hash, action_type, option_id, '{\"tool_call_id\":\"call-1\"}'::jsonb, 'pending', expires_at, NULL, NULL FROM interaction_actions WHERE id = 1")
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,7,'run-a','waiting')", [ownerId])
    await pool.query("INSERT INTO agent_interaction_bindings VALUES ($1,7,'run-a',3,'interaction-1','call-1')", [ownerId])
    const enqueue = createInteractionResumeEnqueuer({ async readForUpdate(_client, identity) { assert.equal(identity.ownerId, ownerId); return { status: 'waiting', pending: { id: 'interaction-1', kind: 'confirmation', toolCall: { id: 'call-1', name: 'tool', input: {} } } } as never } })
    const bridge = createPostgresInteractionConsumeStore(pool, { async applyCommandAction() { throw new Error('unexpected') }, async redeemConfirmation() { return true }, beforeCommit: enqueue })
    await consumeInteractionAction(bridge, { ownerId, promptId: 3, token: 'synthetic-token' })
    const queue = createPostgresInteractionResumeQueue(pool), jobs = await queue.pending()
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.resolution.receiptId, 'web-prompt:3')
    assert.equal(JSON.stringify(jobs).includes('synthetic-token'), false)
    await assert.rejects(deliverInteractionResume(jobs[0]!, queue, async function* () { throw new Error('worker crashed') }))
    assert.equal((await queue.pending()).length, 1)
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,7,'run-a','web-prompt:3')", [ownerId])
    await deliverInteractionResume(jobs[0]!, queue, async function* () { throw new Error('不得重复恢复') })
    assert.equal((await queue.pending()).length, 0)
    const server = '00000000-0000-4000-8000-000000000001'
    const secretSchema = { secret_fields: [{ name: 'key' }], context: { tool_call_id: 'call-secret', secret_target: { kind: 'mcp_credentials', server_id: server } } }
    await pool.query("INSERT INTO interaction_prompts VALUES (4,$1,7,'form','active',clock_timestamp()+interval '1 hour',NULL,$2)", [ownerId, JSON.stringify(secretSchema)])
    await pool.query("INSERT INTO user_mcp_servers VALUES ($1,$2,'user',$3,'','','',1)", [server, ownerId, JSON.stringify([{ id: 'key', target: 'header', prefix: '' }])])
    await pool.query("INSERT INTO agent_interaction_bindings VALUES ($1,7,'run-a',4,'secret-1','call-secret'),($1,7,'run-a',5,'secret-1','call-secret')", [ownerId])
    const secretEnqueue = createInteractionResumeEnqueuer({ async readForUpdate() { return { status: 'waiting', pending: { id: 'secret-1', kind: 'credential', toolCall: { id: 'call-secret', name: 'tool', input: {} } } } as never } })
    const secrets = createPostgresSecretInteraction(pool, { encrypt(value) { assert.equal(value.key, 'synthetic-sensitive'); return encryptByokEnvelope(JSON.stringify(value), 'synthetic-master', 1) }, enqueue: secretEnqueue, async invalidate(client, owner, id) { await client.query('INSERT INTO synthetic_effects VALUES ($1)', [`${owner}:${id}`]) } })
    await assert.rejects(secrets(otherOwnerId, 4, { key: 'synthetic-sensitive' }), /敏感信息输入不存在/)
    await secrets(ownerId, 4, { key: 'synthetic-sensitive' })
    await assert.rejects(secrets(ownerId, 4, { key: 'synthetic-sensitive' }))
    const stored = await pool.query('SELECT p.schema_json, s.encrypted_credentials, s.credentials_nonce, s.encrypted_credentials_key, s.credentials_key_version FROM interaction_prompts p CROSS JOIN user_mcp_servers s WHERE p.id=4')
    assert.equal(JSON.stringify(stored.rows).includes('synthetic-sensitive'), false)
    const ciphertext = stored.rows[0]!
    const decrypted = decryptByokCredential({ encrypted_value: ciphertext.encrypted_credentials, nonce: ciphertext.credentials_nonce, encrypted_data_key: ciphertext.encrypted_credentials_key, key_version: ciphertext.credentials_key_version } as never, () => 'synthetic-master')
    assert.deepEqual(JSON.parse(decrypted), { key: 'synthetic-sensitive' })
    const secretJob = (await queue.pending())[0]!
    assert.equal(secretJob.resolution.status, 'answered'); assert.equal(JSON.stringify(secretJob).includes('synthetic-sensitive'), false)
    await assert.rejects(deliverInteractionResume(secretJob, queue, async function* () { throw new Error('worker stopped') }))
    assert.equal((await queue.pending()).length, 1)
    const claims = await Promise.all([queue.claim(), queue.claim()])
    assert.equal(claims.filter(Boolean).length, 1)
    const firstClaim = claims.find(Boolean)!
    await pool.query("UPDATE agent_interaction_resumes SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE prompt_id=4")
    const recovered = (await queue.claim())!
    assert.notEqual(recovered.claimToken, firstClaim.claimToken)
    await queue.releaseClaim(firstClaim.identity, firstClaim.promptId, firstClaim.claimToken)
    assert.equal(await queue.claim(), null)
    await queue.releaseClaim(recovered.identity, recovered.promptId, recovered.claimToken)
    let invalidations = 0, resumed = 0
    let runStatus: 'waiting' | 'completed' = 'waiting'
    assert.equal(await processOneInteraction({ queue, read: async () => ({ status: runStatus }), invalidateCredential: async (owner, id) => { assert.equal(owner, ownerId); assert.equal(id, server); invalidations++ }, diagnose() {},
      async *resume(identity, resolution) { resumed++; assert.equal(resolution?.status, 'answered'); await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,7,'run-a','web-prompt:4')", [ownerId]); runStatus = 'completed'; yield { identity, id: 'event', sequence: 1, round: 0, type: 'final', payload: {} } } }), true)
    assert.equal(invalidations, 1); assert.equal(resumed, 1); assert.equal((await queue.pending()).length, 0)
    await pool.query("INSERT INTO interaction_prompts VALUES (5,$1,7,'form','active',clock_timestamp()+interval '1 hour',NULL,$2)", [ownerId, JSON.stringify(secretSchema)])
    await secrets(ownerId, 5, null)
    const cancelledJob = (await queue.pending()).find(job => job.promptId === 5)!
    assert.equal(cancelledJob.resolution.status, 'cancelled')
    await assert.rejects(secrets(ownerId, 5, null))
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
