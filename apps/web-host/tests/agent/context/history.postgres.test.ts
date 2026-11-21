import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { loadSessionHistory, restoreHistoryForRequest, type HistoryReaderPort } from '@gugu/core/agent'
import { withAgentHistoryReferences } from '../../../src/modules/agent/context/history.js'
import { resolveAgentChatReferences } from '../../../src/modules/agent/context/references.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('旧历史引用按 owner 水合且不写回，删除对象后不泄漏并保留正文顺序', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `history_refs_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,content text,references_json jsonb,content_json jsonb);
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text,parent_id integer,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,folder_id integer,stage_name text,mime_type text,deleted_at timestamptz,updated_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1' }
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1)', [owner])
    await pool.query("INSERT INTO files VALUES (2,$1,'资料','txt','personal',NULL,'','text/plain',NULL,now())", [owner])
    const refs = [{ type: 'file', id: 2 }]
    await pool.query("INSERT INTO conversation_messages VALUES (9,1,'user','原问题',$1,NULL)", [JSON.stringify(refs)])
    const base: HistoryReaderPort = { async read() { return { baselineSeq: 0, rows: [{ ...identity, id: '9', conversationSeq: 1, role: 'user', content: '原问题' }] } } }
    const history = withAgentHistoryReferences(pool, base)
    const rows = (await loadSessionHistory(identity, history)).rows
    const current = await resolveAgentChatReferences(pool, owner, { message: '原问题', references: refs })
    assert.deepEqual(rows[0]!.contentJson, current)
    const rendered = JSON.stringify(restoreHistoryForRequest(rows[0]!, {}))
    assert.ok(rendered.indexOf('文件 id：2') < rendered.indexOf('原问题'))
    assert.equal((await pool.query('SELECT content_json FROM conversation_messages WHERE id=9')).rows[0].content_json, null)
    await assert.rejects(history.hydrateReferences!({ ...identity, ownerId: other }, rows), /历史身份不匹配/)
    await pool.query('UPDATE files SET deleted_at=now() WHERE id=2')
    const deleted = (await loadSessionHistory(identity, history)).rows
    assert.equal(deleted[0]!.contentJson, undefined)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
