import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTelegramInbox, NODE_IM_INBOUND_STREAM } from '../../../src/modules/im/gateway/platforms/telegram/inbox.js'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'

test('Telegram 入站将事件、去重键及游标交给同一原子命令，忽略事件仍推进游标', async () => {
  const calls: string[][] = []
  const inbox = createTelegramInbox({ sendCommand: async args => { calls.push(args); return 1 } }, '7', 'owner-a', 'synthetic-inbox-secret')
  const payload = { platform: 'telegram', bot_id: '7', channel_id: '7', owner_user_id: 'owner-a', chat_type: 'c2c',
    platform_user_id: '9', chat_id: '9', message_id: '13', text: '合成消息' }
  await inbox.commit(13, payload)
  await inbox.commit(14, null)
  assert.deepEqual(calls.map(args => [args[0], args[2], args[3], args[6]]), [
    ['EVAL', '3', NODE_IM_INBOUND_STREAM, '13'], ['EVAL', '3', NODE_IM_INBOUND_STREAM, '14'],
  ])
  assert.equal(calls[0]![5], calls[1]![5])
  assert.notEqual(calls[0]![4], calls[1]![4])
  assert.deepEqual(createImInboundEnvelope('synthetic-inbox-secret').open({ platform: 'telegram', botId: '7', ownerId: 'owner-a' }, JSON.parse(calls[0]![7]!)), payload)
  assert.equal(createImInboundEnvelope('synthetic-inbox-secret').openForWorker({ platform: 'telegram', botId: '7', ownerId: 'owner-a' }, JSON.parse(calls[0]![7]!)).admission, 'gateway')
  assert.ok(!calls[0]![7]!.includes('合成消息'))
  assert.equal(calls[1]![7], '')
})
test('Telegram群入站的密封payload、注意力buffer和cursor一同提交', async () => {
  const calls: string[][] = []
  const inbox = createTelegramInbox({ sendCommand: async args => { calls.push(args); return 1 } }, '7', 'owner-a', 'synthetic-inbox-secret')
  await inbox.commit(15, { platform: 'telegram', bot_id: '7', channel_id: '7', owner_user_id: 'owner-a', chat_type: 'group',
    platform_user_id: '9', chat_id: '-90', message_id: '15', text: '合成群消息' })
  assert.equal(calls[0]![2], '5')
  assert.match(calls[0]![6]!, /^im:node:attention:scope:v1:/)
  assert.equal(calls[0]![8], '15')
  assert.ok(!calls[0]![9]!.includes('合成群消息'))
})

test('Telegram owner或Bot变化不复用游标和去重键，序列化后路由仍须匹配', async () => {
  const calls: string[][] = []
  const redis = { sendCommand: async (args: string[]) => { calls.push(args); return 1 } }
  for (const [bot, owner] of [['7', 'owner-a'], ['7', 'owner-b'], ['8', 'owner-a']] as const)
    await createTelegramInbox(redis, bot, owner, 'synthetic-inbox-secret').commit(11, null)
  assert.equal(new Set(calls.map(args => args[4])).size, 3)
  assert.equal(new Set(calls.map(args => args[5])).size, 3)
  const inbox = createTelegramInbox(redis, '7', 'owner-a', 'synthetic-inbox-secret')
  await assert.rejects(inbox.commit(11, { platform: 'telegram', bot_id: '7', channel_id: '7', owner_user_id: 'owner-a',
    toJSON() { return { platform: 'telegram', bot_id: '7', channel_id: '7', owner_user_id: 'owner-b' } },
  }), /消息格式无效/)
  assert.equal(calls.length, 3)
})

test('Telegram 游标缺失允许首次轮询；损坏和越界不回落到起点', async () => {
  for (const value of [null, '0', '42']) {
    const inbox = createTelegramInbox({ sendCommand: async () => value }, '7', 'owner-a', 'synthetic-inbox-secret')
    assert.equal(await inbox.cursor(), value === null ? null : Number(value))
  }
  for (const value of ['', '-1', '1.5', '9007199254740992', 42]) {
    const inbox = createTelegramInbox({ sendCommand: async () => value }, '7', 'owner-a', 'synthetic-inbox-secret')
    await assert.rejects(inbox.cursor(), /游标格式无效/)
  }
})

test('Telegram 跨Bot/owner、非法事件不访问Redis，命令失败不声称已入队', async () => {
  let calls = 0
  const inbox = createTelegramInbox({ sendCommand: async () => { calls++; throw new Error('合成敏感上游异常') } }, '7', 'owner-a', 'synthetic-inbox-secret')
  for (const payload of [{ platform: 'qq' }, { platform: 'telegram', bot_id: '8' },
    { platform: 'telegram', bot_id: '7', channel_id: '7', owner_user_id: 'owner-b' }])
    await assert.rejects(inbox.commit(1, payload), /作用域不匹配/)
  await assert.rejects(inbox.commit(Number.NaN, null), /事件 ID 无效/)
  assert.equal(calls, 0)
  await assert.rejects(inbox.commit(1, null), error => error instanceof Error
    && error.message === 'Telegram 入站持久化失败' && error.cause === undefined)
  await assert.rejects(inbox.cursor(), /游标读取失败/)
})
