import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { loadGroupMentionNames } from '../../src/modules/agent-sessions/persistence/agent-group-mentions.js'
import { extractPlatformMentionIds, replacePlatformMentionIds } from '@gugu/core/agent/context/messages'

test('only extracts explicit platform mentions and replaces known IDs in both wire forms', () => {
  assert.deepEqual(extractPlatformMentionIds('mail a@b.test <@member_1> <@!bot-2> <@member_1>'), ['member_1', 'bot-2'])
  const names = new Map([['member_1', '小北'], ['bot-2', '天气 Bot']])
  assert.equal(
    replacePlatformMentionIds('mail a@b.test <@member_1> <@!bot-2> @member_1 <@unknown>', names),
    'mail a@b.test @小北 @天气 Bot @小北 <@unknown>',
  )
})

test('private sessions do not query or rewrite group mentions', async () => {
  let queries = 0
  const names = await loadGroupMentionNames({
    pool: {
      async query() { queries++; return { rows: [], rowCount: 0 } },
    } as never,
    ownerId: 'owner-1', sessionId: 41,
    session: { chatType: 'private', source: 'qq' }, messages: [{
      content: '<@member-1>', quotedText: null, platformBotUserId: null,
    }], currentBotPlatformUserId: null,
  })
  assert.equal(queries, 0)
  assert.equal(replacePlatformMentionIds('<@member-1>', names), '<@member-1>')
})


test('群消息昵称查询不能跨 owner 访问会话', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, schema = `mentions_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE conversation_sessions(id int,user_id uuid,chat_type text,source text); CREATE TABLE conversation_messages(id int,session_id int,platform_user_id text,platform_user_name text,created_at timestamptz); CREATE TABLE user_bots(id int,user_id uuid,platform text,bot_platform_user_id text,name text)')
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'group','qq')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (1,1,'person','旧昵称',now()), (2,1,'person','新昵称',now())")
    await pool.query("INSERT INTO user_bots VALUES (1,$1,'qq','other-bot','二号小咕')", [owner])
    const input = { pool, sessionId: 1, session: { chatType: 'group', source: 'qq' }, messages: [{ content: '<@person> <@own-bot> <@other-bot> <@unknown>', quotedText: '<@person>', platformBotUserId: null }], currentBotPlatformUserId: 'own-bot' }
    const names = await loadGroupMentionNames({ ...input, ownerId: owner })
    assert.equal(names.get('person'), '新昵称')
    assert.equal(names.get('own-bot'), '咕咕')
    assert.equal(names.get('other-bot'), '二号小咕')
    assert.equal(names.has('unknown'), false)
    assert.equal((await loadGroupMentionNames({ ...input, ownerId: other })).has('person'), false)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
