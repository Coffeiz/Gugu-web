import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { Pool } from 'pg'
import { AgentToolEventDetailsNotFoundError, AgentToolEventSessionNotFoundError, createPostgresAgentToolEventDetails } from '../../../src/agent/sessions/tool-event-details.js'
const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
test('PostgreSQL 按 owner 读取并按物理列大小限制时间线', async () => {
  const schema = `tool_details_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE conversation_sessions(id integer primary key,user_id uuid not null); CREATE TABLE conversation_messages(id integer primary key,session_id integer not null,display_timeline jsonb)')
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$2)', [owner, other])
    await pool.query('INSERT INTO conversation_messages VALUES(1,1,$1),(2,2,$1),(3,1,$2)', [JSON.stringify([{ kind: 'tool', toolResult: { type: 'image', data: 'synthetic' } }]), JSON.stringify([{ kind: 'assistant' }])])
    const read = createPostgresAgentToolEventDetails(pool)
    assert.deepEqual(await read(owner, 1, 1, 0), { toolResult: { type: 'text', text: '[图片已查看]' } })
    await assert.rejects(read(owner, 2, 2, 0), AgentToolEventSessionNotFoundError)
    await assert.rejects(read(owner, 1, 2, 0), AgentToolEventDetailsNotFoundError)
    await assert.rejects(read(owner, 1, 3, 0), AgentToolEventDetailsNotFoundError)
    await pool.query("INSERT INTO conversation_messages SELECT 4,1,jsonb_build_array(jsonb_build_object('kind','tool','toolResult',string_agg(md5(n::text),''))) FROM generate_series(1,40000) n")
    const { rows } = await pool.query('SELECT pg_column_size(display_timeline) AS n FROM conversation_messages WHERE id=4')
    assert.ok(rows[0].n > 1048576)
    await assert.rejects(read(owner, 1, 4, 0), AgentToolEventDetailsNotFoundError)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
