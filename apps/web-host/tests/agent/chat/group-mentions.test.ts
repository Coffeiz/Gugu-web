import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { loadGroupMentionNames } from '../../../src/modules/agent/chat/mentions.js'
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


test('QQ 历史分页可识别本会话已见过的机器人提及，未知对象保留原样', async () => {
  const owner = randomUUID()
  const names = await loadGroupMentionNames({
    pool: { async connect() { return { async query() { return { rows: [] } }, release() {} } }, async query(sql: string, params: unknown[]) {
      if (sql.includes('m.platform_bot_user_id=ANY')) {
        assert.deepEqual(params, [41, owner, ['own-bot', 'unknown']])
        return { rows: [{ id: 'own-bot' }] }
      }
      return { rows: [] }
    } } as never,
    ownerId: owner, sessionId: 41, session: { chatType: 'group', source: 'qq' },
    messages: [{ content: '<@own-bot>', quotedText: '<@unknown>', platformBotUserId: null }],
    currentBotPlatformUserId: null,
  })
  assert.equal(replacePlatformMentionIds('<@own-bot> <@unknown>', names), '@咕咕 <@unknown>')
})

test('群消息昵称查询不能跨 owner 访问会话', { skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL' }, async () => {
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, schema = `mentions_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE conversation_sessions(id int,user_id uuid,chat_type text,source text); CREATE TABLE conversation_messages(id int,session_id int,platform_user_id text,platform_user_name text,created_at timestamptz,platform_bot_user_id text); CREATE TABLE user_bots(id int,user_id uuid,platform text,bot_platform_user_id text,name text)')
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'group','qq')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (1,1,'person','旧昵称',now(),'own-bot'), (2,1,'person','新昵称',now(),NULL)")
    await pool.query("INSERT INTO user_bots VALUES (1,$1,'qq','other-bot','二号小咕')", [owner])
    const input = { pool, sessionId: 1, session: { chatType: 'group', source: 'qq' }, messages: [{ content: '<@person> <@own-bot> <@other-bot> <@unknown>', quotedText: '<@person>', platformBotUserId: null }], currentBotPlatformUserId: null }
    const names = await loadGroupMentionNames({ ...input, ownerId: owner })
    assert.equal(names.get('person'), '新昵称')
    assert.equal(names.get('own-bot'), '咕咕')
    assert.equal(names.get('other-bot'), '二号小咕')
    assert.equal(names.has('unknown'), false)
    assert.equal((await loadGroupMentionNames({ ...input, ownerId: other })).has('person'), false)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
