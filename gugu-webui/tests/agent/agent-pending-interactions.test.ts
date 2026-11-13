import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPendingInteractionHistory, InteractionSessionNotFoundError } from '../../src/domains/agent-sessions/application/agent-pending-interactions.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('pending interaction history rotates only active option tokens, restores consumed selection, and commits only on change', async () => {
  const actions = [
    { id: 1, promptId: 9, tokenHash: 'old-hash', status: 'pending', optionId: 'continue', actionType: 'choice', context: {}, expiresAt: new Date('2027-01-01T00:00:00Z') },
    { id: 4, promptId: 9, tokenHash: 'orphan-hash', status: 'pending', optionId: 'legacy-option', actionType: 'choice', context: {}, expiresAt: new Date('2027-01-01T00:00:00Z') },
    { id: 2, promptId: 10, tokenHash: 'used-hash', status: 'consumed', optionId: 'archive', actionType: 'choice', context: {}, expiresAt: new Date('2027-01-01T00:00:00Z') },
    { id: 3, promptId: 11, tokenHash: 'secret-hash', status: 'pending', optionId: 'input_credentials', actionType: 'mcp_secret_input', context: {}, expiresAt: new Date('2027-01-01T00:00:00Z') },
  ]
  const prompts = [
    { id: 9, ownerId: 'owner-a', sessionId: 7, kind: 'confirm', title: '活动确认', body: '确认继续', status: 'active', expiresAt: new Date('2027-01-01T00:00:00Z'), createdAt: new Date('2026-12-31T22:00:00Z'), schema: { options: [{ id: 'continue', label: '继续' }], source: 'system', context: { tool_call_id: 'tool-9' } } },
    { id: 10, ownerId: 'owner-a', sessionId: 7, kind: 'choice', title: '合成选择', body: '请选择', status: 'resolved', expiresAt: new Date('2027-01-01T00:00:00Z'), createdAt: new Date('2026-12-31T23:00:00Z'), schema: { options: [{ id: 'keep', label: '保留' }, { id: 'archive', label: '归档' }], source: 'agent', allow_text_input: true, resolved_result: { text: '归档' }, context: { tool_call_id: 'tool-10' } } },
    { id: 11, ownerId: 'owner-a', sessionId: 7, kind: 'form', title: '凭据', body: '', status: 'active', expiresAt: new Date('2027-01-01T00:00:00Z'), createdAt: new Date('2026-12-31T23:30:00Z'), schema: { secret_fields: [{ name: 'api_key', label: '密钥' }], context: { secret_target: { kind: 'mcp_credentials', credential_value: 'must-not-leak' } } } },
  ]
  let commits = 0, tokenSequence = 0
  const history = createPendingInteractionHistory({
    async sessionOwnedBy(ownerId, sessionId) { return ownerId === 'owner-a' && sessionId === 7 },
    async listPrompts(ownerId, sessionId) { return prompts.filter((prompt) => prompt.ownerId === ownerId && prompt.sessionId === sessionId) },
    async listActions(promptId) { return actions.filter((action) => action.promptId === promptId) },
    async commit() { commits += 1 },
  }, () => `token-${++tokenSequence}`, () => new Date('2026-12-31T23:45:00Z'))
  const result = await history.list('owner-a', 7)
  assert.deepEqual(result[0]?.options, [
    { id: 'continue', label: '继续', token: 'token-1' },
    { id: 'legacy-option', label: 'legacy-option', token: 'token-2' },
  ])
  assert.equal(result[0]?.task_paused, true)
  assert.equal(actions[0]?.tokenHash, createHash('sha256').update('token-1').digest('hex'))
  assert.equal(result[1]?.selected_option_id, 'archive')
  assert.equal(result[1]?.response_text, '归档')
  assert.deepEqual(result[1]?.options, [])
  assert.deepEqual(result[2]?.options, [])
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  assert.equal(commits, 1)
  const historicalOnly = await history.list('owner-a', 7, { restoreActive: false })
  assert.deepEqual(historicalOnly.map((item) => item.id), [10])
  assert.equal(commits, 1)
  await assert.rejects(history.list('owner-b', 7), (error: unknown) => error instanceof InteractionSessionNotFoundError)
  assert.equal(commits, 1)
})

test('PostgreSQL pending action token hash is persisted only for the owning session', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_pending_interaction_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id));
      CREATE TABLE interaction_prompts (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        session_id integer NOT NULL REFERENCES conversation_sessions(id), kind text NOT NULL,
        title text NOT NULL, body text NOT NULL, status text NOT NULL,
        expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, schema_json jsonb NOT NULL
      );
      CREATE TABLE interaction_actions (
        id serial PRIMARY KEY, prompt_id integer NOT NULL REFERENCES interaction_prompts(id),
        status text NOT NULL, option_id text NOT NULL, token_hash text NOT NULL,
        action_type text NOT NULL, context_json jsonb, expires_at timestamptz NOT NULL
      );
    `)
    const owner = randomUUID(), foreignOwner = randomUUID()
    await pool.query('INSERT INTO users (id) VALUES ($1),($2)', [owner, foreignOwner])
    const { rows: [session] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [owner],
    )
    const { rows: [foreignSession] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [foreignOwner],
    )
    const schemaJson = { options: [{ id: 'yes', label: '继续' }], context: { tool_call_id: 'synthetic-call' } }
    const { rows: [prompt] } = await pool.query<{ id: number }>(
      `INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,status,expires_at,created_at,schema_json)
       VALUES ($1,$2,'confirm','合成确认','确认继续','active',now()+interval '1 hour',now(),$3) RETURNING id`,
      [owner, session.id, schemaJson],
    )
    const { rows: [foreignPrompt] } = await pool.query<{ id: number }>(
      `INSERT INTO interaction_prompts (user_id,session_id,kind,title,body,status,expires_at,created_at,schema_json)
       VALUES ($1,$2,'confirm','他人确认','确认继续','active',now()+interval '1 hour',now(),$3) RETURNING id`,
      [foreignOwner, foreignSession.id, schemaJson],
    )
    const { rows: [action] } = await pool.query<{ id: number }>(
      `INSERT INTO interaction_actions (prompt_id,status,option_id,token_hash,action_type,expires_at)
       VALUES ($1,'pending','yes','old-hash','confirm',now()+interval '1 hour') RETURNING id`, [prompt.id],
    )
    const changedActions: Array<{ id: number; tokenHash: string }> = []
    const history = createPendingInteractionHistory({
      async sessionOwnedBy(ownerId, sessionId) {
        const found = await pool.query('SELECT 1 FROM conversation_sessions WHERE id=$1 AND user_id=$2', [sessionId, ownerId])
        return Boolean(found.rowCount)
      },
      async listPrompts(ownerId, sessionId) {
        const found = await pool.query<any>(
          `SELECT id, user_id AS "ownerId", session_id AS "sessionId", kind, title, body, status,
                  expires_at AS "expiresAt", created_at AS "createdAt", schema_json AS schema
           FROM interaction_prompts WHERE user_id=$1 AND session_id=$2`, [ownerId, sessionId],
        )
        return found.rows
      },
      async listActions(promptId) {
        const found = await pool.query<any>(
          `SELECT id, prompt_id AS "promptId", token_hash AS "tokenHash", status,
                  option_id AS "optionId", action_type AS "actionType", context_json AS context,
                  expires_at AS "expiresAt" FROM interaction_actions WHERE prompt_id=$1 ORDER BY id`, [promptId],
        )
        changedActions.push(...found.rows)
        return found.rows
      },
      async commit() {
        for (const changed of changedActions)
          await pool.query('UPDATE interaction_actions SET token_hash=$1 WHERE id=$2', [changed.tokenHash, changed.id])
      },
    }, () => 'synthetic-fresh-token')
    const result = await history.list(owner, session.id)
    assert.equal(result.length, 1)
    assert.equal((await pool.query('SELECT token_hash FROM interaction_actions WHERE id=$1', [action.id])).rows[0]?.token_hash,
      createHash('sha256').update('synthetic-fresh-token').digest('hex'))
    await assert.rejects(history.list(owner, foreignSession.id), (error: unknown) => error instanceof InteractionSessionNotFoundError)
    assert.equal((await pool.query('SELECT token_hash FROM interaction_actions WHERE prompt_id=$1', [foreignPrompt.id])).rowCount, 0)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
