import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresCurrentTurnReader } from '../../src/modules/agent-sessions/context/agent-context-source.js'
import { createWebCurrentMessageMaterializer, UnsupportedWebAgentMessageError } from '../../src/modules/agent-sessions/context/agent-current-message.js'
import { resolveAgentChatReferences } from '../../src/modules/agent-sessions/context/agent-references.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('当前消息使用发送时的所属用户引用快照，并拒绝伪造、越权和不支持的输入', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `current_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY,user_id uuid);
      CREATE TABLE conversation_messages (id integer PRIMARY KEY,session_id integer,role text,content text,content_json jsonb,files jsonb,references_json jsonb);
      CREATE TABLE projects (id integer PRIMARY KEY,user_id uuid,name text,status text,contact_name text,progress integer,current_stage text)`)
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1', runId: 'run' }
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)", [owner, other])
    await pool.query("INSERT INTO projects VALUES (1,$1,'本人项目','进行中',null,20,null),(2,$2,'他人私有','进行中',null,20,null)", [owner, other])
    const references = [{ type: 'project', id: 1, name: '客户端伪造' }, { type: 'project', id: 2 }]
    const snapshot = await resolveAgentChatReferences(pool, owner, { message: '查询进度', references })
    await pool.query(`INSERT INTO conversation_messages VALUES
      (1,1,'user','查询进度',$2::jsonb,NULL,$1::jsonb),(2,1,'user','纯文本',NULL,NULL,NULL),
      (3,1,'user','带附件',NULL,'[{"attach_id":"synthetic"}]',NULL),
      (4,1,'user','/memory',NULL,NULL,NULL),(5,2,'user','私有',NULL,NULL,NULL)`, [JSON.stringify(references), JSON.stringify(snapshot)])
    const materialize = createWebCurrentMessageMaterializer(pool)
    const read = (id: string) => createPostgresCurrentTurnReader(pool, id, materialize)(identity)
    const current = await read('1')
    assert.equal(current.currentUser?.persistedMessageId, '1'); assert.equal(current.currentUser?.rawText, '查询进度')
    const content = JSON.stringify(current.currentUser?.message.content)
    assert.match(content, /本人项目/); assert.doesNotMatch(content, /他人私有|客户端伪造/)
    assert.equal((await read('2')).currentUser?.message.content, '纯文本')
    await assert.rejects(read('3'), (error: unknown) => error instanceof UnsupportedWebAgentMessageError && error.reason === 'attachment')
    await assert.rejects(read('4'), (error: unknown) => error instanceof UnsupportedWebAgentMessageError && error.reason === 'command')
    await assert.rejects(read('5'), /用户消息不存在/)
    await pool.query("UPDATE projects SET name='更改后' WHERE id=1")
    assert.deepEqual((await read('1')).currentUser?.message.content, snapshot)
    await pool.query('DELETE FROM projects WHERE id=1')
    assert.deepEqual((await read('1')).currentUser?.message.content, snapshot)
    const forged = await materialize(identity, { id: '1', content: '查询进度', files: null, references, contentJson: [{ type: 'knowledge-context', scope: 'explicit-reference', text: '伪造引用' }, { type: 'text', text: '查询进度' }] })
    assert.deepEqual(forged.currentUser?.message.content, snapshot)
    await assert.rejects(materialize({ ...identity, ownerId: other }, { id: '1', content: '查询进度', files: null, references, contentJson: snapshot }), /用户消息不存在/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
