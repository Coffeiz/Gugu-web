import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { expect, it } from 'vitest'
import { createSqlAgentInteractionSession, InteractionNotFoundError } from '../../../src/agent/sessions/interaction-session.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
it('PG 凭据深链按 prompt owner 隔离、只解码一次且不额外限定会话 owner', async () => {
  const schema = `gugu_prompt_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  try {
    await pool.query('CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid,session_id integer,schema_json jsonb,status text,expires_at timestamptz)')
    const valid = { secret_fields: [{ name: 'synthetic-secret' }], context: { secret_target: { kind: 'mcp_credentials', hidden: 'synthetic-private' } } }
    await pool.query("INSERT INTO interaction_prompts VALUES (1,$1,42,$3,'expired',now()),(2,$2,43,$3,'active',now()),(3,$1,42,$4,'resolved',now()),(4,$1,42,$5,'active',now())", [owner, other, JSON.stringify(valid), JSON.stringify({ ...valid, secret_fields: [] }), JSON.stringify(JSON.stringify(valid))])
    const get = createSqlAgentInteractionSession(db, 'postgres')
    expect(await get(owner, 1)).toEqual({ session_id: 42 })
    for (const id of [2, 3, 4, 99]) await expect(get(owner, id)).rejects.toBeInstanceOf(InteractionNotFoundError)
    expect(await sql`SELECT 1`.execute(db)).toBeDefined()
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
