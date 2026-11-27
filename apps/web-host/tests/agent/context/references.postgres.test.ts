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
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,title text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,content text);`)
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO conversation_sessions VALUES (5,$1,'会话')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (6,5,'原消息')")
    const client = await pool.connect()
    try {
      const input = { message: '用户问题', references: [{ type: 'file', id: 2, label: '展示标签' }, { type: 'file', id: 3 }, { type: 'file', id: 4 }, { type: 'conversation', id: 6 }] }
      const content = await resolveAgentChatReferences(client, owner, input)
      const text = String((content![0] as { text: string }).text)
      assert.match(text, /【类型】对话\n【ID】6/)
      assert.doesNotMatch(text, /【类型】文件|展示标签/)
      assert.deepEqual(content![1], { type: 'text', text: '用户问题' })
      assert.equal(await resolveAgentChatReferences(client, other, { message: '', references: [{ type: 'file', id: 2 }, { type: 'conversation', id: 6 }] }), null)
    } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('旧数字文件与目录引用无需查表，也不会注入上下文', async () => {
  const db = { query: async () => { throw new Error('旧引用不得查询数据库') } }
  const result = await resolveAgentChatReferences(db, randomUUID(), {
    message: '查看引用', references: [{ type: 'file', id: 1 }, { type: 'folder', id: 2 }],
  })
  assert.equal(result, null)
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
    assert.match((content[0] as { text: string }).text, /【路径】"\/personal\/资料\/会议记录\.md"/)
    assert.match((content[0] as { text: string }).text, /【相对路径】"资料\/会议记录\.md"/)
    assert.doesNotMatch(JSON.stringify(content), /客户端伪造|个人文件/)
    assert.match((content[0] as { text: string }).text, /gugu:\/\/open-object\/file\/path-/)
    assert.deepEqual(content[1], { type: 'text', text: message })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('文件技能引用限定当前用户并注入沙盒目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-web-skill-reference-'))
  const owner = randomUUID(), other = randomUUID()
  const db = { query: async () => { throw new Error('文件技能引用不应查询数据库') } }
  try {
    const { createUserSkillBundle } = await import('@gugu/core/skills')
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 技能名称\ndescription: 技能简介\n---\n不应注入的正文')
    const input = { message: '问题', references: [{ type: 'skill', id: 'demo', label: '伪造名称' }] }
    const result = await resolveAgentChatReferences(db, owner, input, root)
    assert.ok(result)
    assert.match(JSON.stringify(result), /技能名称/u)
    assert.match(JSON.stringify(result), /\/workspace\/\.agent\/skills\/demo/u)
    assert.doesNotMatch(JSON.stringify(result), /不应注入的正文|伪造名称/u)
    assert.equal(await resolveAgentChatReferences(db, other, input, root), null)
    for (const id of ['U1', 1]) {
      assert.equal(await resolveAgentChatReferences(db, owner, {
        ...input, references: [{ type: 'skill', id, label: '旧技能' }],
      }, root), null)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
