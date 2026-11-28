import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createNodeImInbox, NODE_IM_INBOUND_STREAM, nodeImAttentionKeys, NodeImInboxError } from '../../../../src/modules/im/gateway/inbound/inbox.js'
import type { NodeImBotBinding } from '../../../../src/modules/im/gateway/inbound/inbox.js'

const binding: NodeImBotBinding = { platform: 'qq', botId: '7', ownerId: 'owner-synthetic' }
const payload = { platform: 'qq', channel_id: '7', owner_user_id: 'owner-synthetic', chat_type: 'group', chat_id: 'group-synthetic', platform_user_id: 'sender-synthetic', message_id: 'event-synthetic', text: '合成正文' }
/** 仅验证命令契约，绝不模拟执行Lua或冒充真实Redis状态验收。 */
function commandFixture() {
  const calls: string[][] = []
  let reply: unknown = '1760000000000-0'
  const inbox = createNodeImInbox({ async sendCommand(command) { calls.push(command); return reply } })
  return { inbox, calls, setReply(value: unknown) { reply = value } }
}

test('命令契约：单次EVAL包含主Stream、群scope/start和10分钟/30分钟TTL', async () => {
  const f = commandFixture()
  assert.equal(await f.inbox.enqueue(binding, payload), '1760000000000-0')
  assert.equal(f.calls.length, 1)
  const command = f.calls[0]!
  assert.equal(command[0], 'EVAL'); assert.equal(command[2], '4')
  assert.match(command[3]!, /^im:node:seen:[a-f0-9]{64}$/)
  assert.equal(command[4], NODE_IM_INBOUND_STREAM)
  const attention = nodeImAttentionKeys(binding, payload.chat_id)
  assert.equal(command[5], attention.stream); assert.equal(command[6], attention.start)
  assert.equal(command[7], '10000'); assert.equal(command[9], '600'); assert.equal(command[10], '1800')
  assert.deepEqual(JSON.parse(command[8]!), { ...payload, bot_id: binding.botId })
})

test('命令契约：私聊只有seen和主Stream，重复结果直接映射null', async () => {
  const f = commandFixture(); f.setReply(null)
  assert.equal(await f.inbox.enqueue(binding, { ...payload, chat_type: 'c2c', chat_id: undefined }), null)
  assert.equal(f.calls[0]![2], '2')
  assert.equal(f.calls[0]![4], 'im:node:inbound')
})

test('键契约：owner/平台/Bot/群/成员/消息隔离，channel与bot字段规范化后稳定', async () => {
  const f = commandFixture()
  await f.inbox.enqueue(binding, payload)
  await f.inbox.enqueue(binding, { ...payload, bot_id: binding.botId })
  assert.equal(f.calls[0]![3], f.calls[1]![3])
  const variants: [NodeImBotBinding, Record<string, unknown>][] = [
    [binding, { ...payload, chat_id: 'other-group' }], [binding, { ...payload, platform_user_id: 'other-sender' }],
    [binding, { ...payload, message_id: 'other-event' }], [{ ...binding, ownerId: 'other-owner' }, { ...payload, owner_user_id: 'other-owner' }],
    [{ ...binding, botId: '8' }, { ...payload, channel_id: '8' }],
    [{ ...binding, platform: 'telegram' }, { ...payload, platform: 'telegram' }],
  ]
  for (const [bot, item] of variants) await f.inbox.enqueue(bot, item)
  assert.equal(new Set(f.calls.slice(1).map(command => command[3])).size, 7)
  assert.notDeepEqual(nodeImAttentionKeys(binding, 'group-synthetic'), nodeImAttentionKeys({ ...binding, ownerId: 'other-owner' }, 'group-synthetic'))
})

test('pending resume以稳定恢复ID去重，与原始平台消息身份分离', async () => {
  const f = commandFixture()
  await f.inbox.enqueue(binding, { ...payload, _pending_ask_resume_id: 'resume-synthetic' })
  await f.inbox.enqueue(binding, { ...payload, message_id: 'different-message', _pending_ask_resume_id: 'resume-synthetic' })
  assert.equal(f.calls[0]![3], f.calls[1]![3])
  await f.inbox.enqueue(binding, { ...payload, message_id: 'resume-synthetic' })
  assert.notEqual(f.calls[0]![3], f.calls[2]![3])
})

test('不接受payload跨owner/平台/Bot或缺稳定身份，不发送任何Redis命令', async () => {
  const f = commandFixture()
  for (const item of [{ ...payload, owner_user_id: 'other' }, { ...payload, platform: 'telegram' }, { ...payload, channel_id: '8' },
    { ...payload, bot_id: '8' }, { ...payload, platform_user_id: '' }, { ...payload, chat_id: '' }, { ...payload, message_id: '  ' },
    { ...payload, toJSON() { return { ...payload, owner_user_id: 'other' } } }])
    await assert.rejects(f.inbox.enqueue(binding, item), error => error instanceof NodeImInboxError && error.code === 'invalid_input')
  assert.equal(f.calls.length, 0)
})

test('UTF8体积、配置和JSON错误静态拒绝，不泄露上下文token或原始异常', async () => {
  let calls = 0
  const inbox = createNodeImInbox({ async sendCommand() { calls++; return null } }, { maxPayloadBytes: 1000 })
  await assert.rejects(inbox.enqueue(binding, { ...payload, text: '鸟'.repeat(1000), context_token: 'synthetic-context-token' }), error => error instanceof NodeImInboxError && !error.message.includes('token'))
  const cyclic: Record<string, unknown> = { ...payload }; cyclic.self = cyclic
  await assert.rejects(inbox.enqueue(binding, cyclic), NodeImInboxError)
  assert.equal(calls, 0)
  assert.throws(() => createNodeImInbox({ sendCommand: async () => null }, { maxLength: 0 }), NodeImInboxError)
  const failed = createNodeImInbox({ async sendCommand() { throw new Error('synthetic-private-response') } })
  await assert.rejects(failed.enqueue(binding, payload), error => error instanceof NodeImInboxError && error.code === 'unavailable' && !error.message.includes('private'))
})

test('键只含摘要不含聊天或context，损坏Redis回复不伪装入队成功', async () => {
  const f = commandFixture()
  await f.inbox.enqueue(binding, { ...payload, message_id: 'synthetic-context-secret', context_token: 'synthetic-context-secret' })
  assert.equal(f.calls[0]!.slice(3, 7).join('').includes('secret'), false)
  f.setReply('synthetic-private-response')
  await assert.rejects(f.inbox.enqueue(binding, payload), error => error instanceof NodeImInboxError && error.code === 'invalid_reply' && !error.message.includes('private'))
})

const redisUrl = process.env.GUGU_IM_GATEWAY_TEST_REDIS_URL
test('隔离Redis：Lua去重、同ID群索引、TTL及错误类型零部分写入', {
  skip: !redisUrl && '未运行：需显式GUGU_IM_GATEWAY_TEST_REDIS_URL指向独占隔离Redis库；命令替身不证明Lua原子行为',
}, async () => {
  const { createRedisGatewayIngressCommands } = await import('../../../../src/adapters/cache/redis-events.js')
  const commands = createRedisGatewayIngressCommands(redisUrl!)
  const run = async (script: string, keys: string[], ...args: string[]) => commands.sendCommand(['EVAL', script, String(keys.length), ...keys, ...args])
  // 固定Node namespace不能在已有运行库试验；缺独占隔离库直接拒绝，不清空用户Stream。
  assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [NODE_IM_INBOUND_STREAM]), '0', '测试要求空的独占隔离Redis库')
  const bot = { ...binding, ownerId: `synthetic-${randomUUID()}`, botId: `synthetic-${randomUUID()}` }
  const value = { ...payload, owner_user_id: bot.ownerId, channel_id: bot.botId }
  const attention = nodeImAttentionKeys(bot, value.chat_id)
  const usedKeys = [NODE_IM_INBOUND_STREAM, attention.stream, attention.start]
  const recording = { async sendCommand(parts: string[]) {
    const count = Number(parts[2]); for (const key of parts.slice(3, 3 + count)) if (!usedKeys.includes(key)) usedKeys.push(key)
    return commands.sendCommand(parts)
  } }
  const inbox = createNodeImInbox(recording)
  try {
    // 用错误scope类型触发真实Lua预检；此时main和seen必须仍不存在。
    await run("redis.call('SET',KEYS[1],'wrongtype');return 'ok'", [attention.stream])
    await assert.rejects(inbox.enqueue(bot, value), NodeImInboxError)
    assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [NODE_IM_INBOUND_STREAM]), '0')
    const seen = usedKeys.find(key => key.startsWith('im:node:seen:'))!
    assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [seen]), '0')
    await run("return redis.call('DEL',KEYS[1])", [attention.stream])
    for (const key of [seen, NODE_IM_INBOUND_STREAM, attention.start]) {
      const setup = key === NODE_IM_INBOUND_STREAM ? "redis.call('SET',KEYS[1],'wrongtype');return 'ok'" : "redis.call('LPUSH',KEYS[1],'wrongtype');return 'ok'"
      await run(setup, [key])
      await assert.rejects(inbox.enqueue(bot, value), NodeImInboxError)
      for (const other of usedKeys.filter(candidate => candidate !== key))
        assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [other]), '0')
      await run("return redis.call('DEL',KEYS[1])", [key])
    }
    // scope先于主Stream的异常水位必须在主入队之前拒绝。
    await run("return redis.call('XADD',KEYS[1],'9999999999999-0','data','synthetic')", [attention.stream])
    await assert.rejects(inbox.enqueue(bot, value), NodeImInboxError)
    assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [NODE_IM_INBOUND_STREAM]), '0')
    assert.equal(await run("return redis.call('EXISTS',KEYS[1])", [seen]), '0')
    await run("return redis.call('DEL',KEYS[1])", [attention.stream])
    const id = await inbox.enqueue(bot, value)
    assert.ok(id)
    assert.equal(await inbox.enqueue(bot, value), null)
    assert.equal(await run("return redis.call('XLEN',KEYS[1])", [NODE_IM_INBOUND_STREAM]), '1')
    assert.equal(await run("return redis.call('XLEN',KEYS[1])", [attention.stream]), '1')
    assert.equal(await run("return redis.call('XRANGE',KEYS[1],'-','+')[1][1]", [attention.stream]), id)
    assert.equal(await run("return redis.call('GET',KEYS[1])", [attention.start]), id!.split('-')[0])
    for (const [key, max] of [[seen, 600], [attention.stream, 1800], [attention.start, 1800]] as const) {
      const ttl = Number(await run("return redis.call('TTL',KEYS[1])", [key]))
      assert.ok(ttl > 0 && ttl <= max)
    }
    const wechat = { ...bot, platform: 'wechat' as const }
    const first = { ...value, platform: 'wechat', chat_type: 'c2c', chat_id: undefined,
      message_id: 'synthetic-context', context_token: 'synthetic-context', platform_event_id: 'message:100' }
    const second = { ...first, platform_event_id: 'message:101' }
    const firstId = await inbox.enqueue(wechat, first)
    const secondId = await inbox.enqueue(wechat, second)
    assert.ok(firstId && secondId)
    assert.notEqual(firstId, secondId)
    assert.equal(await inbox.enqueue(wechat, first), null)
    assert.equal(await run("return redis.call('XLEN',KEYS[1])", [NODE_IM_INBOUND_STREAM]), '3')
  } finally { await run("return redis.call('DEL',unpack(KEYS))", usedKeys) }
})
