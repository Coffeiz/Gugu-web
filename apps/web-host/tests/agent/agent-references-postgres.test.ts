import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { resolveAgentChatReferences } from '../../src/modules/agent/context/references.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('显式引用只读取 owner 对象，保留目录及消息锚点且不混淆展示输入', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `refs_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text,parent_id integer,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,folder_id integer,stage_name text,mime_type text,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,title text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,content text);`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO folders VALUES (1,$1,'参考',NULL,NULL)", [owner])
    await pool.query("INSERT INTO files VALUES (2,$1,'文档','txt','personal',1,'','text/plain',NULL,now()),(3,$2,'私有','txt','personal',NULL,'',NULL,NULL,now()),(4,$1,'删除','txt','personal',NULL,'',NULL,now(),now())", [owner, other])
    await pool.query("INSERT INTO conversation_sessions VALUES (5,$1,'会话')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (6,5,'原消息')")
    const client = await pool.connect()
    try {
      const input = { message: '用户问题', references: [{ type: 'file', id: 2, label: '展示标签' }, { type: 'file', id: 3 }, { type: 'file', id: 4 }, { type: 'conversation', id: 6 }] }
      const content = await resolveAgentChatReferences(client, owner, input)
      const text = String((content![0] as { text: string }).text)
      assert.match(text, /文件 id：2/); assert.match(text, /目录：参考（folder_id=1）/); assert.match(text, /消息 id：6/)
      assert.doesNotMatch(text, /私有|删除|展示标签/)
      assert.deepEqual(content![1], { type: 'text', text: '用户问题' })
      assert.equal(await resolveAgentChatReferences(client, other, { message: '', references: [{ type: 'file', id: 2 }, { type: 'conversation', id: 6 }] }), null)
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
