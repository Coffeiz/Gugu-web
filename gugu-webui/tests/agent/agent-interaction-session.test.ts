import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createInteractionSessionLookup, InteractionNotFoundError } from '../../src/domains/agent-sessions/persistence/agent-interaction-session.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('交互深链查询限定 owner 与 prompt，且不投影敏感字段', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params })
      return {
        rows: [{
          session_id: 41,
          schema_json: {
            secret_fields: [{ name: 'api_key', label: '密钥' }],
            context: { secret_target: { kind: 'mcp_credentials', server_id: 'hidden-server' } },
          },
        }],
        rowCount: 1,
      }
    },
  }
  const result = await createInteractionSessionLookup(pool as never).get('trusted-owner', 8)
  assert.deepEqual(result, { session_id: 41 })
  assert.deepEqual(calls[0]?.params, [8, 'trusted-owner'])
  assert.doesNotMatch(calls[0]!.sql, /expires_at|status|secret_fields|secret_target/)
  assert.equal(JSON.stringify(result).includes('hidden-server'), false)
})

test('凭据交互深链仅回显所属会话，不回显敏感字段；过期提示仍按 Python 路由解析', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_interaction_session_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions (id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id));
      CREATE TABLE interaction_prompts (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        session_id integer NOT NULL REFERENCES conversation_sessions(id),
        schema_json jsonb, status text NOT NULL, expires_at timestamptz NOT NULL
      );
    `)
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [owner, other])
    const { rows: [ownSession] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [owner],
    )
    const { rows: [foreignSession] } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [other],
    )
    const secretSchema = {
      secret_fields: [{ name: 'api_key', label: '服务密钥' }],
      context: { secret_target: { kind: 'mcp_credentials', server_id: 'synthetic-server' } },
    }
    const { rows: [active] } = await pool.query<{ id: number }>(
      'INSERT INTO interaction_prompts (user_id,session_id,schema_json,status,expires_at) VALUES ($1,$2,$3,\'active\',now()+interval \'1 hour\') RETURNING id',
      [owner, ownSession.id, secretSchema],
    )
    const { rows: [expired] } = await pool.query<{ id: number }>(
      'INSERT INTO interaction_prompts (user_id,session_id,schema_json,status,expires_at) VALUES ($1,$2,$3,\'expired\',now()-interval \'1 hour\') RETURNING id',
      [owner, ownSession.id, secretSchema],
    )
    const { rows: [ordinary] } = await pool.query<{ id: number }>(
      'INSERT INTO interaction_prompts (user_id,session_id,schema_json,status,expires_at) VALUES ($1,$2,$3,\'active\',now()+interval \'1 hour\') RETURNING id',
      [owner, ownSession.id, { secret_fields: [], context: {} }],
    )
    const { rows: [foreign] } = await pool.query<{ id: number }>(
      'INSERT INTO interaction_prompts (user_id,session_id,schema_json,status,expires_at) VALUES ($1,$2,$3,\'active\',now()+interval \'1 hour\') RETURNING id',
      [other, foreignSession.id, secretSchema],
    )
    const lookup = createInteractionSessionLookup(pool)
    assert.deepEqual(await lookup.get(owner, active.id), { session_id: ownSession.id })
    assert.deepEqual(await lookup.get(owner, expired.id), { session_id: ownSession.id })
    for (const promptId of [ordinary.id, foreign.id, 9999]) {
      await assert.rejects(
        lookup.get(owner, promptId),
        (error: unknown) => error instanceof InteractionNotFoundError && error.statusCode === 404,
      )
    }
    const response = await lookup.get(owner, active.id)
    assert.deepEqual(Object.keys(response), ['session_id'])
    assert.equal(JSON.stringify(response).includes('api_key'), false)
    assert.equal(JSON.stringify(response).includes('synthetic-server'), false)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
