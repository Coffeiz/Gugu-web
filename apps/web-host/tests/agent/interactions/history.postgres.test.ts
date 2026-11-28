import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '@gugu/core/data'
import { createWebDelegatedConfirmationAuthorization } from '../../../src/modules/agent/tools/confirm.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresAgentInteractionHistory } from '@gugu/core/agent-sessions'
import { claimInteractionResumeLocked, createInteractionResumeEnqueuer } from '../../../src/modules/agent/interactions/resume.js'
import { createAgentInteractionRespondService } from '../../../src/modules/agent/interactions/respond.js'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('父会话投影子运行确认并提交到原子运行，父取消拒绝旧令牌', { skip: !databaseUrl }, async () => {
  const schema = `delegated_interaction_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const owner = randomUUID()
  try {
    await pool.query(`
      CREATE TABLE interaction_prompts (id integer PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,
        body text,schema_json jsonb,status text,expires_at timestamptz,created_at timestamptz,resolved_at timestamptz);
      CREATE TABLE interaction_actions (id integer,prompt_id integer,token_hash text,action_type text,option_id text,
        context_json jsonb,status text,expires_at timestamptz,consumed_at timestamptz,consumed_event_id text);
      CREATE TABLE agent_subagent_deliveries (owner_id text,parent_session_id text,parent_run_id text,child_id text,child_run_id text,status text);
      CREATE TABLE agent_subagent_executions (child_session_id integer,child_run_id text);
      CREATE TABLE users (id uuid,security_version integer,is_active boolean,account_status text);
      CREATE TABLE agent_run_leases (user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_run_checkpoints (user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_dispatch (user_id uuid,session_id integer,run_id text,cancel_requested boolean);
      CREATE TABLE agent_interaction_bindings (user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes (user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,
        receipt text,created_at timestamptz,completed_at timestamptz,claim_token text,claim_expires_at timestamptz);
      CREATE TABLE agent_run_interaction_receipts (user_id uuid,session_id integer,run_id text,receipt text);
      INSERT INTO agent_subagent_executions VALUES (8,'child-run'),(9,'child-other');
    `)
    await pool.query("INSERT INTO agent_subagent_deliveries VALUES ($1,'7','parent-run','eafb1234','child-run','running'),($1,'7','parent-run','eafb1235','child-other','running')", [owner])
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,7,'parent-run','waiting'),($1,8,'child-run','waiting'),($1,9,'child-other','waiting')", [owner])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,7,'parent-run',false)", [owner])
    const schemaJson = { source: 'agent', context: { tool_call_id: 'tool-call' }, options: [{ id: 'confirm', label: '确认' }] }
    await pool.query(`INSERT INTO interaction_prompts
      SELECT n,$1,n+7,'confirm','合成确认','合成目标',$2,'active',clock_timestamp()+interval '5 minutes',clock_timestamp(),NULL
      FROM generate_series(1,2) AS n`, [owner, schemaJson])
    await pool.query(`INSERT INTO interaction_actions
      SELECT id,id,'hash','confirm','confirm','{"tool_call_id":"tool-call"}','pending',expires_at,NULL,NULL FROM interaction_prompts`)
    await pool.query("INSERT INTO agent_interaction_bindings VALUES ($1,8,'child-run',1,'confirm-child','tool-call'),($1,9,'child-other',2,'confirm-other','tool-call')", [owner])
    const history = createPostgresAgentInteractionHistory(pool, undefined, '合成确认密钥', true)
    const cards = await history(owner, 7, { restoreActive: true })
    assert.deepEqual(cards.map(card => [card.session_id, card.run_id, card.delegated]), [[7, 'parent-run', true], [7, 'parent-run', true]])
    assert.deepEqual(await history(randomUUID(), 7, { restoreActive: true }), [])
    const executor = { ownerId: owner, sessionId: '8', runId: 'child-run' }
    await pool.query("INSERT INTO users VALUES ($1,3,true,'active')", [owner])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,8,'child-run',clock_timestamp()+interval '1 minute')", [owner])
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    const parent = { ownerId: owner, sessionId: '7', runId: 'parent-run' }
    const authority = createWebDelegatedConfirmationAuthorization(db, parent, executor, 'synthetic-scope')
    const signal = AbortSignal.timeout(5000)
    assert.equal(await authority.authorize(executor, signal), '3:synthetic-scope')
    assert.equal(await authority.authorize(parent, signal), null)
    const wrongParent = createWebDelegatedConfirmationAuthorization(db, { ...parent, runId: 'wrong-parent' }, executor, 'synthetic-scope')
    assert.equal(await wrongParent.authorize(executor, signal), null)
    const service = createAgentInteractionRespondService({
      pool, routeDelegated: true,
      effects: { async redeemConfirmation() { throw new Error('意外的权限授权') }, async applyCommandAction() { throw new Error('意外的写操作') } },
      enqueue: createInteractionResumeEnqueuer({ async readForUpdate(_client, identity) {
        assert.deepEqual(identity, executor)
        return { status: 'waiting', pending: { id: 'confirm-child', kind: 'confirmation', toolCall: { id: 'tool-call' } } } as never
      } }, true),
      async wake() { assert.fail('不应唤醒父运行') }, diagnose() { assert.fail('不应尝试唤醒父运行') },
    })
    const first = await service.respond(owner, 1, cards[0]!.options[0]!.token)
    assert.equal(first.session_id, 7)
    assert.equal(first.run_id, 'parent-run')
    assert.deepEqual(await service.findResolvedRun?.(owner, 1, cards[0]!.options[0]!.token),
      { session_id: 7, run_id: 'parent-run', status: 'confirmed', option_id: 'confirm' })
    const claim = await withPostgresTransaction(pool, client => claimInteractionResumeLocked(client, executor))
    assert.equal(claim?.resolution.interactionId, 'confirm-child')
    assert.equal(claim?.resolution.status, 'confirmed')
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,8,'child-run','web-prompt:1')", [owner])
    const reopened = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    try {
      assert.equal(await withPostgresTransaction(reopened, client => claimInteractionResumeLocked(client, executor)), null)
    } finally { await reopened.end() }
    await pool.query('UPDATE agent_run_dispatch SET cancel_requested=true')
    assert.equal(await authority.authorize(executor, signal), null)
    await assert.rejects(service.respond(owner, 2, cards[1]!.options[0]!.token), /交互已结束/)
    assert.deepEqual((await history(owner, 7, { restoreActive: true })).find(card => card.id === 2)?.options, [])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

test('interaction history owner-scopes prompts, keeps projected tokens stable for active actions and restores the Python DTO', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_interaction_history_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  const foreignOwnerId = randomUUID()
  const now = new Date('2026-11-16T01:00:00.000Z')

  try {
    await pool.query(`
      CREATE TABLE interaction_prompts (
        id serial PRIMARY KEY, user_id uuid NOT NULL, session_id integer NOT NULL,
        kind text NOT NULL, title text NOT NULL, body text NOT NULL, schema_json jsonb NOT NULL,
        status text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE interaction_actions (
        id serial PRIMARY KEY, prompt_id integer NOT NULL, token_hash text NOT NULL,
        option_id text NOT NULL, action_type text NOT NULL, context_json jsonb NOT NULL,
        status text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
        consumed_event_id text, created_at timestamptz NOT NULL
      );
    `)
    const activeSchema = {
      options: [{ id: 'approve', label: '允许' }], source: 'agent', allow_text_input: true,
      secret_fields: ['password'], context: { tool_call_id: 'tool-active', opaque_secret: 'must-not-return' },
    }
    const endedSchema = {
      options: [{ id: 'approve', label: '允许' }], context: { tool_call_id: 'tool-ended' },
      resolved_result: { text: '用户已允许' },
    }
    const { rows: [active] } = await pool.query<{ id: number }>(
      `INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
       VALUES ($1,7,'confirm','活动确认','确认内容',$2,'active',$3,$4) RETURNING id`,
      [ownerId, activeSchema, new Date(now.getTime() + 60_000), new Date(now.getTime() - 1000)],
    )
    const { rows: [ended] } = await pool.query<{ id: number }>(
      `INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
       VALUES ($1,7,'confirm','历史确认','已结束',$2,'resolved',$3,$4) RETURNING id`,
      [ownerId, endedSchema, new Date(now.getTime() - 60_000), new Date(now.getTime() - 2000)],
    )
    await pool.query(
      `INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
       VALUES ($1,7,'confirm','他人会话','不应返回',$2,'resolved',$3,$4)`,
      [foreignOwnerId, { context: { tool_call_id: 'tool-ended' } }, new Date(now.getTime() - 60_000), now],
    )
    const oldTokenHash = createHash('sha256').update('old-token').digest('hex')
    await pool.query(
      `INSERT INTO interaction_actions (prompt_id,token_hash,option_id,action_type,context_json,status,expires_at,created_at)
       VALUES ($1,$2,'approve','choice','{"private":"never-return"}','pending',$3,$4),
              ($1,'expired-hash','expired','choice','{}','pending',$5,$4),
              ($6,'consumed-hash','approve','choice','{}','consumed',$5,$4)`,
      [active.id, oldTokenHash, new Date(now.getTime() + 60_000), now, new Date(now.getTime() - 1), ended.id],
    )

    const history = createPostgresAgentInteractionHistory(pool, () => now)
    const restored = await history(ownerId, 7, { restoreActive: true })
    assert.deepEqual(restored.map((item) => item.id), [ended.id, active.id])
    const endedPrompt = restored[0] as Record<string, any>
    const activePrompt = restored[1] as Record<string, any>
    assert.equal(activePrompt.resolved, false)
    assert.equal(activePrompt.options.length, 1)
    assert.equal(activePrompt.options[0].id, 'approve')
    assert.equal(activePrompt.options[0].label, '允许')
    assert.equal(activePrompt.options[0].token.length, 32)
    const refreshed = await history(ownerId, 7, { restoreActive: true })
    assert.deepEqual(refreshed.find(item => item.id === active.id)?.options, activePrompt.options)
    assert.equal(activePrompt.tool_call_id, 'tool-active')
    assert.deepEqual(activePrompt.secret_fields, ['password'])
    assert.equal(JSON.stringify(activePrompt).includes('must-not-return'), false)
    assert.equal(JSON.stringify(activePrompt).includes('never-return'), false)
    assert.equal(JSON.stringify(activePrompt).includes('old-token'), false)
    assert.equal(endedPrompt.resolved, true)
    assert.equal(endedPrompt.selected_option_id, 'approve')
    assert.equal(endedPrompt.response_text, '用户已允许')

    const saved = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM interaction_actions WHERE prompt_id = $1 ORDER BY id LIMIT 1', [active.id],
    )
    assert.equal(saved.rows[0]?.token_hash,
      createHash('sha256').update(activePrompt.options[0].token).digest('hex'))
    assert.notEqual(saved.rows[0]?.token_hash, oldTokenHash)

    const historicalRun = await history(ownerId, 7, {
      restoreActive: false,
      toolCallIds: ['tool-ended'],
    })
    assert.deepEqual(historicalRun.map((item) => item.id), [ended.id])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
