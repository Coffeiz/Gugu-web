import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractPlatformMentionIds,
  loadGroupMentionNames,
  replacePlatformMentionIds,
} from '../../src/domains/agent-sessions/persistence/agent-group-mentions.js'

test('only extracts explicit platform mentions and replaces known IDs in both wire forms', () => {
  assert.deepEqual(extractPlatformMentionIds('mail a@b.test <@member_1> <@!bot-2> <@member_1>'), ['member_1', 'bot-2'])
  const names = new Map([['member_1', '小北'], ['bot-2', '天气 Bot']])
  assert.equal(
    replacePlatformMentionIds('mail a@b.test <@member_1> <@!bot-2> @member_1 <@unknown>', names),
    'mail a@b.test @小北 @天气 Bot @小北 <@unknown>',
  )
})

test('group mention names prefer latest session nickname, then current Bot name, then another owned Bot', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params })
      if (sql.includes('DISTINCT ON (platform_user_id)')) return {
        rows: [{ id: 'member-1', name: '小北改名后' }], rowCount: 1,
      }
      if (sql.includes('FROM user_bots')) return {
        rows: [{ id: 'other-bot', name: '二号小咕' }], rowCount: 1,
      }
      throw new Error('unexpected query')
    },
  }
  const names = await loadGroupMentionNames({
    pool: pool as never, ownerId: 'owner-1', sessionId: 41,
    session: { chatType: 'group', source: 'qq' }, messages: [{
      content: '<@member-1> <@own-bot> <@other-bot> <@unknown>',
      quotedText: '<@other-bot> 早上好', platformBotUserId: null,
    }], currentBotPlatformUserId: 'own-bot',
  })

  assert.equal(names.get('member-1'), '小北改名后')
  assert.equal(names.get('own-bot'), '咕咕')
  assert.equal(names.get('other-bot'), '二号小咕')
  assert.equal(names.has('unknown'), false)
  assert.equal(statements.length, 2)
  assert.deepEqual(statements[0]?.params, [41, ['member-1', 'own-bot', 'other-bot', 'unknown']])
  assert.deepEqual(statements[1]?.params, ['owner-1', 'qq'])
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
