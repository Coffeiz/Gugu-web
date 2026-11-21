import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createRedisStreamCommands } from '../../../../src/adapters/cache/redis-stream-commands.js'
import { createRedisImPendingAskStore, pumpImPendingAsks, PENDING_ASK_RUN_PROOF_TTL_SECONDS } from '../../../../src/modules/im/gateway/interactions/ask.js'

const signal = new AbortController().signal
const scope = { ownerId: randomUUID(), botId: '42', platform: 'qq' as const, groupId: 'synthetic-group' }
const trigger = (at: number, eventId = 'synthetic-event') => ({ eventId, eventMs: at, platformMessageId: 'synthetic-platform-message', senderId: 'synthetic-member', payload: { text: '合成敏感问题', context_token: 'synthetic-private-context', attachments: [] } })

test('延迟ASK只接受精确单事件；取消发生前不写Redis，错误不包含正文或凭据', async () => {
  const calls: string[][] = []
  const store = createRedisImPendingAskStore({ redis: { async sendCommand(parts) { calls.push(parts); throw new Error('synthetic-private-context') } }, secretKey: 'synthetic-key' })
  await assert.rejects(store.register(scope, { ...trigger(1000), payload: { _batch_messages: [trigger(1000)] } }), /群延迟回复状态暂时不可用/u)
  const cancelled = AbortSignal.abort(new Error('cancelled'))
  await assert.rejects(store.register(scope, trigger(1000), cancelled), /cancelled/u)
  assert.equal(calls.length, 0)
  await assert.rejects(store.register(scope, trigger(1000)), error => error instanceof Error && error.message === '群延迟回复状态暂时不可用')
  assert.ok(!JSON.stringify(calls).includes('合成敏感问题'))
  assert.ok(!JSON.stringify(calls).includes('synthetic-private-context'))
})

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('真实Redis：加密原始ASK、60秒/静默窗口、重启稳定唤醒、未知投递重试和CAS拒绝旧完成', { skip: !redisUrl && '需要显式隔离 Redis' }, async () => {
  const commands = createRedisStreamCommands(redisUrl!), keys = new Set<string>(), calls: string[][] = []
  const redis = { async sendCommand(parts: string[]) {
    calls.push(parts)
    if (parts[0] === 'EVAL') for (const key of parts.slice(3, 3 + Number(parts[2]))) if (!key.includes(':due:')) keys.add(key)
    return commands.sendCommand(parts)
  } }
  let now = Date.now(); const base = now, secretKey = randomUUID(), own = { ...scope, ownerId: randomUUID() }
  let store = createRedisImPendingAskStore({ redis, secretKey, now: () => now })
  const inspect = (script: string, more: string[] = []) => commands.sendCommand(['EVAL', script, String(keys.size + 1), ...keys, 'im:node:{pending-ask}:due:v1', ...more])
  try {
    const original = trigger(base)
    const firstId = await store.register(own, original, signal)
    assert.ok(firstId)
    const pendingKey=[...keys].find(key=>!key.includes(':issued:')&&!key.endsWith(':activity')&&!key.endsWith(':cancelled'))!
    const rawBefore=await commands.sendCommand(['GET',pendingKey]),ttlBefore=Number(await commands.sendCommand(['EVAL',"return redis.call('TTL',KEYS[1])",'1',pendingKey]))
    const dueBefore=await commands.sendCommand(['EVAL',"return redis.call('ZRANGE',KEYS[1],0,-1,'WITHSCORES')",'1','im:node:{pending-ask}:due:v1'])
    const callsBefore=calls.length
    assert.equal(await store.hasPending(own,signal),true)
    assert.equal(calls.length,callsBefore+1);assert.equal(calls.at(-1)?.[0],'GET')
    assert.equal(await commands.sendCommand(['GET',pendingKey]),rawBefore)
    assert.ok(Number(await commands.sendCommand(['EVAL',"return redis.call('TTL',KEYS[1])",'1',pendingKey]))<=ttlBefore,'保留检查不延长待唤醒ASK的TTL')
    assert.deepEqual(await commands.sendCommand(['EVAL',"return redis.call('ZRANGE',KEYS[1],0,-1,'WITHSCORES')",'1','im:node:{pending-ask}:due:v1']),dueBefore)
    assert.ok(!JSON.stringify(calls).includes(original.payload.text)); assert.ok(!JSON.stringify(calls).includes(original.payload.context_token))
    now = base + 59_999; assert.deepEqual(await store.claimDue(100, signal), [])
    await store.observe(own, { eventMs: base + 50_000, senderId: 'another-bot' }, signal)
    now = base + 60_000; assert.deepEqual(await store.claimDue(100, signal), [])
    now = base + 80_000
    store = createRedisImPendingAskStore({ redis, secretKey, now: () => now })
    const claimed = await store.claimDue(100, signal)
    assert.equal(claimed.length, 1); assert.deepEqual(claimed[0]?.trigger, original); assert.equal(claimed[0]?.resumeId, firstId)
    assert.equal(await store.isIssued(claimed[0]!),true)
    const issuedKey=[...keys].find(key=>key.includes(':issued:'))!
    const issuedTtl=Number(await commands.sendCommand(['EVAL',"return redis.call('TTL',KEYS[1])",'1',issuedKey]))
    assert.ok(issuedTtl>600&&issuedTtl<=PENDING_ASK_RUN_PROOF_TTL_SECONDS)
    assert.deepEqual(await store.claimDue(100, signal), [])
    // claim不删除；进程在派发前崩溃，5秒后仍得到完全相同原事件与稳定resumeID。
    now += 5000
    const replay = await store.claimDue(100, signal); assert.deepEqual(replay, claimed)
    const newer = trigger(base + 81_000, 'new-ask'); await store.register(own, newer, signal)
    assert.equal(await store.complete(claimed[0]!, signal), false)
    now = base + 141_000
    const attempts: string[] = []
    await assert.rejects(pumpImPendingAsks({ store, authorize: async () => true, dispatch: async r => { attempts.push(r.resumeId); throw new Error('synthetic unknown write') } }, signal), /synthetic unknown write/u)
    now += 5000
    assert.equal(await pumpImPendingAsks({ store, authorize: async () => true, dispatch: async r => { attempts.push(r.resumeId); assert.deepEqual(r.trigger, newer) } }, signal), 1)
    assert.equal(attempts[0], attempts[1]); now += 5000; assert.deepEqual(await store.claimDue(), [])
    const raw = await inspect("local a={}; for i=1,#KEYS-1 do a[#a+1]=redis.call('GET',KEYS[i]) end; return a")
    assert.ok(!JSON.stringify(raw).includes(original.payload.text)); assert.ok(!JSON.stringify(raw).includes(original.payload.context_token))
  } finally {
    await inspect("for i=1,#KEYS-1 do redis.call('DEL',KEYS[i]); local id=string.match(KEYS[i],':v1:([a-f0-9]+)$'); if id then redis.call('ZREM',KEYS[#KEYS],id) end end; return 1")
    await commands.close()
  }
})

test('真实Redis：其他人原生回复取消，自己回复/本Bot不取消；跨scope、取消水位、180秒上限及撤权', { skip: !redisUrl && '需要显式隔离 Redis' }, async () => {
  const commands = createRedisStreamCommands(redisUrl!), keys = new Set<string>()
  const redis = { async sendCommand(parts: string[]) {
    if (parts[0] === 'EVAL') for (const key of parts.slice(3, 3 + Number(parts[2]))) if (!key.includes(':due:')) keys.add(key)
    return commands.sendCommand(parts)
  } }
  let now = Date.now(); const base = now
  const own = { ...scope, ownerId: randomUUID() }, store = createRedisImPendingAskStore({ redis, secretKey: randomUUID(), now: () => now })
  try {
    await store.register(own, trigger(base))
    await store.observe(own, { eventMs: base + 5000, senderId: 'synthetic-member', replyTo: 'synthetic-platform-message' })
    await store.observe(own, { eventMs: base + 55_000, senderId: 'own-bot', ownBotId: 'own-bot' })
    now = base + 60_000; const [ask] = await store.claimDue(); assert.ok(ask)
    for (const other of [{ ...own, groupId: 'other-group' }, { ...own, ownerId: randomUUID() }, { ...own, botId: '43' }, { ...own, platform: 'telegram' as const }])
      await store.observe(other, { eventMs: now, senderId: 'other', replyTo: 'synthetic-platform-message' })
    assert.equal(await store.isCancelled(ask), false)
    await store.observe(own, { eventMs: now, senderId: 'other', replyTo: 'synthetic-platform-message' })
    assert.equal(await store.isCancelled(ask), true)
    const cancelKey=[...keys].find(key=>key.includes(':cancelled:')&&key.endsWith(ask.resumeId.split(':')[0]!))!
    const cancelTtl=Number(await commands.sendCommand(['EVAL',"return redis.call('TTL',KEYS[1])",'1',cancelKey]))
    assert.ok(cancelTtl>600&&cancelTtl<=PENDING_ASK_RUN_PROOF_TTL_SECONDS)
    assert.equal(await store.register(own, trigger(base)), null)
    now += 5000; assert.deepEqual(await store.claimDue(), [])
    const secondBase = now
    await store.register(own, trigger(secondBase))
    await store.observe(own, { eventMs: secondBase + 179_000, senderId: 'other' })
    now = secondBase + 180_000; assert.deepEqual(await store.claimDue(), [])
    now += 60_000; await store.register(own, trigger(now))
    now += 60_000
    const [old] = await store.claimDue(); assert.ok(old)
    const sameMs = { ...old.trigger, eventId: 'same-ms-new-event' }
    await store.register(own, sameMs)
    assert.equal(await store.complete(old), false)
    let sent = 0
    assert.equal(await pumpImPendingAsks({ store, authorize: async () => false, dispatch: async () => { sent++ } }, signal), 0)
    assert.equal(sent, 0); now += 5000; assert.deepEqual(await store.claimDue(), [])
    // 结构化明确召唤在没有pending时也写取消水位，迟到旧ASK不能重建。
    await store.observe(own, { eventMs: now, senderId: 'other', directMention: true })
    assert.equal(await store.register(own, trigger(now - 1000)), null)
  } finally {
    await commands.sendCommand(['EVAL', "for i=1,#KEYS-1 do redis.call('DEL',KEYS[i]); local id=string.match(KEYS[i],':v1:([a-f0-9]+)$'); if id then redis.call('ZREM',KEYS[#KEYS],id) end end; return 1", String(keys.size + 1), ...keys, 'im:node:{pending-ask}:due:v1'])
    await commands.close()
  }
})
