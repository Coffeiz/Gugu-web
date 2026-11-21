import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { resolveAgentChatReferences } from '../../../src/modules/agent/context/references.js'
import { createWorkspaceFileReads } from '../../../src/modules/workspaces/files.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('显式引用只读取 owner 对象，保留目录及消息锚点且不混淆展示输入', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `refs_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text,parent_id integer,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,folder_id integer,stage_name text,mime_type text,deleted_at timestamptz,updated_at timestamptz,storage_key text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,title text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,content text);`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO folders VALUES (1,$1,'参考',NULL,NULL)", [owner])
    await pool.query("INSERT INTO files VALUES (2,$1,'文档','txt','personal',1,'','text/plain',NULL,now(),$1::text || '/个人文件/参考/文档.txt'),(3,$2,'私有','txt','personal',NULL,'',NULL,NULL,now(),NULL),(4,$1,'删除','txt','personal',NULL,'',NULL,now(),now(),NULL)", [owner, other])
    await pool.query("INSERT INTO conversation_sessions VALUES (5,$1,'会话')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (6,5,'原消息')")
    const client = await pool.connect()
    try {
      const input = { message: '用户问题', references: [{ type: 'file', id: 2, label: '展示标签' }, { type: 'file', id: 3 }, { type: 'file', id: 4 }, { type: 'conversation', id: 6 }] }
      const content = await resolveAgentChatReferences(client, owner, input)
      const text = String((content![0] as { text: string }).text)
      assert.match(text, /【文件ID】2/); assert.match(text, /【目录】"参考（folder_id=1）"/); assert.match(text, /消息 id：6/)
      assert.match(text, /【沙盒绝对路径】"\/personal\/参考\/文档\.txt"/)
      assert.doesNotMatch(text, /私有|删除|展示标签/)
      assert.deepEqual(content![1], { type: 'text', text: '用户问题' })
      assert.equal(await resolveAgentChatReferences(client, other, { message: '', references: [{ type: 'file', id: 2 }, { type: 'conversation', id: 6 }] }), null)
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('文件 ID 只将所属用户可挂载的存储路径投影为沙盒路径', async () => {
  const owner = randomUUID()
  const other = randomUUID()
  const db = { query: async (_query: string, values: unknown[]) => ({
    rows: [{
      id: values[0], display_name: '文档', ext: 'txt', space: 'personal',
      storage_key: `${values[0] === 1 ? owner : other}/个人文件/文档.txt`,
    }],
  }) } as Parameters<typeof resolveAgentChatReferences>[0]
  const content = await resolveAgentChatReferences(db, owner, {
    message: '查看引用', references: [{ type: 'file', id: 1 }, { type: 'file', id: 2 }],
  })
  const text = (content?.[0] as { text: string }).text
  assert.equal(text.match(/【沙盒绝对路径】/g)?.length, 1)
  assert.match(text, /【沙盒绝对路径】"\/personal\/文档\.txt"/)
  assert.doesNotMatch(text, new RegExp(`${owner}|${other}`))
})

test('磁盘文件引用和正文组装在同一条消息中，沙盒路径从已授权文件重建', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-chat-disk-ref-'))
  const owner = randomUUID()
  const db = { query: async () => { throw new Error('个人磁盘文件不查询文件记录') } }
  try {
    const directory = join(root, owner, '个人文件', '资料')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '会议记录.md'), '测试正文')
    const reference = await createWorkspaceFileReads(db, root).reference(owner, 'personal', '资料/会议记录.md')
    const decoded = JSON.parse(Buffer.from(reference.id.slice(5), 'base64url').toString('utf8'))
    decoded.sandboxPath = '/personal/客户端伪造.md'
    const id = 'path-' + Buffer.from(JSON.stringify(decoded)).toString('base64url')
    const message = '整理这份会议记录'
    const content = await resolveAgentChatReferences(db, owner, { message, references: [{ ...reference, id }] }, root)
    assert.ok(content)
    assert.equal(content.length, 2)
    assert.match((content[0] as { text: string }).text, /【沙盒绝对路径】"\/personal\/资料\/会议记录\.md"/)
    assert.match((content[0] as { text: string }).text, /【相对路径】"资料\/会议记录\.md"/)
    assert.doesNotMatch(JSON.stringify(content), /客户端伪造|个人文件|path-/)
    assert.deepEqual(content[1], { type: 'text', text: message })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
