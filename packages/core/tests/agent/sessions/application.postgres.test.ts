import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { Pool } from 'pg'
import { createAgentSessionApplication } from '../../../src/agent/sessions/application.js'
import { createPostgresAgentSessionRepository } from '../../../src/agent/sessions/data.js'

async function contract(app: ReturnType<typeof createAgentSessionApplication>, seed: (owner: string, other: string) => Promise<void>) {
  const owner = randomUUID(), other = randomUUID()
  await seed(owner, other)
  assert.deepEqual(await app.rename(owner, 1, `  ${'😀'.repeat(300)}  `), { id: 1, title: '😀'.repeat(300), title_locked: true })
  await assert.rejects(app.rename(owner, 1, '😀'.repeat(301)), /标题过长/)
  await assert.rejects(app.rename(owner, 1, '  '), /标题不能为空/)
  assert.equal(await app.rename(owner, 2, '越权'), null)
  assert.deepEqual(await app.locate(owner, 1), { id: 1, sessionId: 1 })
  for (const id of [2, 3, 4, 5]) assert.equal(await app.locate(owner, id), null)
}

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
test('PostgreSQL 与 SQLite 共享会话及消息用例', async () => {
  const schema = `agent_sessions_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE conversation_sessions(id integer primary key,user_id uuid,title text,title_locked boolean); CREATE TABLE conversation_messages(id integer primary key,session_id integer,role text,content_json jsonb)')
    const app = createAgentSessionApplication(createPostgresAgentSessionRepository(pool))
    await contract(app, async (owner, other) => {
      await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'旧',false),(2,$2,'其他',false)", [owner, other])
      await pool.query("INSERT INTO conversation_messages VALUES (1,1,'user',NULL),(2,1,'assistant','[]'),(3,1,'summary',NULL),(4,2,'user',NULL),(5,1,'assistant','null')")
    })
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
