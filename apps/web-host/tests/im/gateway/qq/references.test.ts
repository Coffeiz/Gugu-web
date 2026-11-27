import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createRedisStreamCommands } from '../../../../src/adapters/cache/redis-stream-commands.js'
import { createQqReferenceStore, QQ_FACE_PENDING_MS, QQ_REFERENCE_TTL_SECONDS, QQ_REFERENCE_MAX_ENTRIES } from '../../../../src/modules/im/gateway/platforms/qq/reference-store.js'
import { qqRedisDouble } from '../helpers/qq-redis-double.js'

const signal = new AbortController().signal
const scope = { ownerId: '11111111-1111-4111-8111-111111111111', botId: '4', platform: 'qq' as const, chatType: 'group' as const, chatId: 'group-a', platformUserId: 'member-a' }
const a = [{ face_type: '6', face_id: 'face-a' }], b = [{ face_type: '6', face_id: 'face-b' }]
test('引用索引加密正文及签名URL，重建store可恢复；同群引用他人而私聊/跨群/Bot/owner隔离', async () => {
  const db = qqRedisDouble(), store = createQqReferenceStore({ redis: db.redis, secretKey: 'synthetic-reference-master', now: db.now })
  const entry = { sender_id: 'member-a', content: '合成敏感聊天', attachments: [{ url: 'https://cdn.example.test/file?sign=synthetic-private' }] }
  await store.remember(scope, 'idx-a', entry, signal)
  assert.ok(!JSON.stringify(db.calls).includes(entry.content)); assert.ok(!JSON.stringify(db.calls).includes(entry.attachments[0]!.url))
  const reopened = createQqReferenceStore({ redis: db.redis, secretKey: 'synthetic-reference-master', now: db.now })
  assert.deepEqual(await reopened.read({ ...scope, platformUserId: 'member-b' }, 'idx-a', signal), entry)
  for (const other of [{ ...scope, chatId: 'group-b' }, { ...scope, ownerId: randomUUID() }, { ...scope, botId: '5' }, { ...scope, chatType: 'c2c' as const, chatId: null }])
    assert.equal(await reopened.read(other, 'idx-a', signal), null)
  db.advance(QQ_REFERENCE_TTL_SECONDS * 1000 + 1)
  assert.equal(await reopened.read(scope, 'idx-a', signal), null)
})
test('FIFO本人配对、事件去重和图片重试复用配对收据，不会吃掉下一表情；3秒边界过期', async () => {
  const db = qqRedisDouble(), store = createQqReferenceStore({ redis: db.redis, secretKey: 'synthetic-reference-master', now: db.now })
  await store.queueFace(scope, 'face-event-a', a, signal); await store.queueFace(scope, 'face-event-a', a, signal)
  await store.queueFace(scope, 'face-event-b', b, signal)
  assert.deepEqual(await store.takeFace({ ...scope, platformUserId: 'member-b' }, 'other-image', signal), [])
  assert.deepEqual(await store.takeFace(scope, 'image-a', signal), a)
  assert.deepEqual(await store.takeFace(scope, 'image-a', signal), a)
  assert.deepEqual(await store.takeFace(scope, 'image-b', signal), b)
  await store.queueFace(scope, 'face-event-c', a, signal)
  db.advance(QQ_FACE_PENDING_MS)
  assert.deepEqual(await store.takeFace(scope, 'late-image', signal), [])
})
test('空配对也有事件收据，图片重放不偷配随后才到的face；128批cap拒绝增长', async () => {
  const db = qqRedisDouble(), store = createQqReferenceStore({ redis: db.redis, secretKey: 'synthetic-reference-master', now: db.now })
  assert.deepEqual(await store.takeFace(scope, 'early-image', signal), [])
  await store.queueFace(scope, 'face-a', a, signal)
  assert.deepEqual(await store.takeFace(scope, 'early-image', signal), [])
  assert.deepEqual(await store.takeFace(scope, 'new-image', signal), a)
  for (let i = 0; i < 128; i++) await store.queueFace(scope, `burst-${i}`, a, signal)
  await assert.rejects(store.queueFace(scope, 'over-cap', b, signal), /QQ 引用或表情状态暂时不可用/)
})

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('真实Redis Lua：索引TTL/cap、原子FIFO去重及跨speaker隔离', { skip: !redisUrl && '需要显式隔离 Redis' }, async () => {
  const commands = createRedisStreamCommands(redisUrl!), keys = new Set<string>(), calls: string[][] = []
  const redis = { sendCommand: async (parts: string[]) => {
    calls.push(parts)
    if (parts[0] === 'EVAL') for (const key of parts.slice(3, 3 + Number(parts[2]))) keys.add(key)
    return commands.sendCommand(parts)
  } }
  const own = { ...scope, ownerId: randomUUID() }; let now = Date.now()
  const store = createQqReferenceStore({ redis, secretKey: randomUUID(), now: () => now })
  const run = (script: string, keys: string[], ...args: string[]) => commands.sendCommand(['EVAL', script, String(keys.length), ...keys, ...args])
  try {
    await store.remember(own, 'idx-a', { content: '合成Redis引用', sender_id: own.platformUserId }, signal)
    assert.equal((await store.read({ ...own, platformUserId: 'member-b' }, 'idx-a', signal))?.content, '合成Redis引用')
    const refKeys = [...keys], dataKey = refKeys[0]!, registry = refKeys[1]!
    const ttl = Number(await run("return redis.call('TTL',KEYS[1])", [dataKey]))
    assert.ok(ttl > 0 && ttl <= QQ_REFERENCE_TTL_SECONDS)
    const prefix = registry.slice(0, -'entries'.length)
    await run("for i=1,50000 do redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]..'synthetic-'..i) end; return 1", [registry], String(now - 1000), prefix)
    await store.remember(own, 'idx-b', { content: '第二条' }, signal)
    assert.equal(Number(await run("return redis.call('ZCARD',KEYS[1])", [registry])), QQ_REFERENCE_MAX_ENTRIES)
    const cutoff = now - QQ_REFERENCE_TTL_SECONDS * 1000
    await run("for i=1,50000 do redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2]..'expired-'..i) end; return 1", [registry], String(cutoff), prefix)
    await store.remember(own, 'idx-c', { content: '清理后写入' }, signal)
    assert.equal(Number(await run("return redis.call('ZCOUNT',KEYS[1],'-inf',ARGV[1])", [registry], String(cutoff))), 0)
    assert.equal(Number(await run("return redis.call('ZCARD',KEYS[1])", [registry])), QQ_REFERENCE_MAX_ENTRIES)
    assert.equal((await store.read(own, 'idx-b', signal))?.content, '第二条')
    await store.queueFace(own, 'face-a', a, signal); await store.queueFace(own, 'face-a', a, signal); await store.queueFace(own, 'face-b', b, signal)
    assert.deepEqual(await store.takeFace({ ...own, platformUserId: 'member-b' }, 'image-other', signal), [])
    assert.deepEqual(await store.takeFace(own, 'image-a', signal), a)
    assert.deepEqual(await store.takeFace(own, 'image-a', signal), a)
    assert.deepEqual(await store.takeFace(own, 'image-b', signal), b)
    await store.queueFace(own, 'face-expired', a, signal); now += QQ_FACE_PENDING_MS
    assert.deepEqual(await store.takeFace(own, 'image-expired', signal), [])
    const queued = calls.find(parts => parts[0] === 'EVAL' && parts.length === 7)!, fifo = queued[3]!
    const record = { ...JSON.parse(queued[5]!), expires: now + 3000 }
    await run("redis.call('DEL',KEYS[1]); for i=1,128 do redis.call('RPUSH',KEYS[1],ARGV[1]) end; redis.call('EXPIRE',KEYS[1],4); return 1", [fifo], JSON.stringify(record))
    await assert.rejects(store.queueFace(own, 'over-cap-real', b, signal), /QQ 引用或表情状态暂时不可用/)
    assert.equal(Number(await run("return redis.call('LLEN',KEYS[1])", [fifo])), 128)
    assert.deepEqual(await store.takeFace(own, 'cap-image', signal), a)
    // TYPE失败发生在SET/dedup写入之前，不留下假的消费事实。
    await run("redis.call('DEL',KEYS[1]); redis.call('SET',KEYS[1],'wrong-type'); return 1", [fifo])
    await assert.rejects(store.queueFace(own, 'wrong-type-event', a, signal))
    assert.equal(await commands.sendCommand(['GET', calls.at(-1)![4]!]), null)
    await run("redis.call('DEL',KEYS[1]); redis.call('SET',KEYS[1],'wrong-type'); return 1", [registry])
    await assert.rejects(store.remember(own, 'type-failure', { content: '不得写入' }, signal))
    assert.equal(await commands.sendCommand(['GET', calls.at(-1)![3]!]), null)
    const reopened = createQqReferenceStore({ redis, secretKey: 'wrong-master', now: () => now })
    assert.equal(await reopened.read(own, 'idx-a', signal), null)
  } finally {
    if (keys.size) await run("return redis.call('DEL',unpack(KEYS))", [...keys])
    await commands.close()
  }
})
