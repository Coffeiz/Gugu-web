import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresAgentInteractionHistory } from '../../src/domains/agent-sessions/persistence/agent-interaction-history.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('interaction history owner-scopes prompts, rotates only active action tokens and restores the Python DTO', {
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
    const restored = await history.list(ownerId, 7, { restoreActive: true })
    assert.deepEqual(restored.map((item) => item.id), [ended.id, active.id])
    const endedPrompt = restored[0] as Record<string, any>
    const activePrompt = restored[1] as Record<string, any>
    assert.equal(activePrompt.resolved, false)
    assert.equal(activePrompt.options.length, 1)
    assert.equal(activePrompt.options[0].id, 'approve')
    assert.equal(activePrompt.options[0].label, '允许')
    assert.equal(activePrompt.options[0].token.length, 32)
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

    const historicalRun = await history.list(ownerId, 7, {
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
