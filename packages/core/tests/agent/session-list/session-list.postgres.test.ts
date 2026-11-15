import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { Pool } from 'pg'
import { createPostgresAgentSessionLister } from '../../../src/agent/sessions/list.js'

const runtime = { activeStatuses: async (ids: number[]) => new Map(ids.filter(id => id === 1).map(id => [id, true])), filesystemAuthorizationEnabled: () => true, workspaceShellSupported: () => true }
async function check(list: (owner: string) => Promise<Record<string, unknown>[]>, owner: string) {
  const result = await list(owner), web = result.find(row => row.id === 1)!, im = result.find(row => row.id === 2)!, blank = result.find(row => row.id === 3)!
  assert.deepEqual(result.map(row => row.id), [3, 2, 1])
  assert.equal(web.lastAssistantId, 2); assert.equal(web.isRunning, true); assert.equal(web.filesystemAuthorized, true)
  assert.equal(web.workspaceName, '工作区'); assert.equal(web.goalStatus, 'paused')
  assert.equal(im.lastAssistantId, undefined); assert.equal(im.isRunning, undefined); assert.equal(im.filesystemAuthorized, false)
  assert.equal(blank.lastAssistantId, 0); assert.equal(blank.source, ''); assert.equal(blank.workspaceName, null)
  assert.equal(web.updatedAt, '2026-01-01T00:00:00.123456Z')
  assert.equal((await list(randomUUID())).length, 0)
}

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
test('PostgreSQL 与 SQLite 会话列表行为一致', async () => {
  const schema = `agent_list_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE workspaces(id integer primary key,name text,user_id uuid); CREATE TABLE conversation_sessions(id integer primary key,user_id uuid,title text,source text,chat_type text,workspace_id integer,session_context jsonb,updated_at timestamptz,created_at timestamptz); CREATE TABLE conversation_messages(id integer primary key,session_id integer,role text,content text,content_json jsonb,files jsonb,conversation_seq integer); CREATE TABLE filesystem_authorization_grants(user_id uuid,subject_type text,subject_id text,revoked_at timestamptz,expires_at timestamptz)`)
    const owner = randomUUID()
    await pool.query("INSERT INTO workspaces VALUES (1,'工作区',$1),(2,'他人私有',$2)", [owner, randomUUID()])
    await pool.query(`INSERT INTO conversation_sessions VALUES (1,$1,'网页','web','private',1,'{"goal_mode":true,"goal_text":"目标","goal_status":"paused"}','2026-01-01T00:00:00.123456Z','2026-01-01'),(2,$1,'IM','qq','group',NULL,NULL,'2026-01-02','2026-01-01'),(3,$1,'空来源','','private',2,NULL,'2026-01-03','2026-01-01')`, [owner])
    await pool.query(`INSERT INTO conversation_messages VALUES (1,1,'assistant','正文',NULL,NULL,1),(2,1,'assistant','',NULL,'[{"id":1}]',2),(3,1,'assistant','工具','null',NULL,3),(4,1,'assistant','',NULL,'[]',4)`)
    await pool.query("INSERT INTO filesystem_authorization_grants VALUES ($1,'session','1',NULL,NULL),($1,'session','2',NULL,'2000-01-01')", [owner])
    const list = createPostgresAgentSessionLister(pool, runtime)
    await check(list, owner)
    await pool.query("UPDATE conversation_sessions SET session_context=to_jsonb('普通字符串'::text) WHERE id=1")
    assert.equal((await list(owner)).find(row => row.id === 1)?.goalStatus, null)
    await pool.query("UPDATE conversation_sessions SET created_at='2026-01-01T08:00:00.123450+08:00' WHERE id=1")
    assert.equal((await list(owner)).find(row => row.id === 1)?.createdAt, '2026-01-01T00:00:00.12345Z')
    for (let i = 0; i < 51; i++) await pool.query("INSERT INTO conversation_sessions VALUES ($1,$3,'网页','web','private',NULL,NULL,'2027-01-01','2026-01-01'),($2,$3,'IM','qq','group',NULL,NULL,'2027-01-01','2026-01-01')", [100 + i, 200 + i, owner])
    const limited = await list(owner)
    assert.equal(limited.filter(row => row.source === 'web').length, 50)
    assert.equal(limited.filter(row => row.source !== 'web').length, 50)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
