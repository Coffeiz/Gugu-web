import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQqReplySequences } from '../../../src/modules/im/gateway/qq/sequences.js'

test('QQ文本媒体stream首帧共用原子序号命令与70分钟首次TTL，owner/Bot/事件隔离', async () => {
  const calls: string[][] = []
  const counters = new Map<string, number>()
  const redis = { async sendCommand(parts: string[]) { calls.push(parts); const next = (counters.get(parts[3]!) ?? 0) + 1; counters.set(parts[3]!, next); return String(next) } }
  const a = createQqReplySequences(redis, { ownerId: 'owner-a', botId: '7' })
  const b = createQqReplySequences(redis, { ownerId: 'owner-b', botId: '7' })
  const input = { botId: '7', messageId: 'message-a', ttlSeconds: 4200 as const }
  assert.deepEqual(await Promise.all([a.nextPassive(input), a.nextPassive(input), a.nextPassive(input)]), [1, 2, 3])
  assert.equal(await b.nextPassive(input), 1)
  assert.equal(await a.nextPassive({ ...input, messageId: 'message-b' }), 1)
  assert.deepEqual(calls.map(parts => [parts[0], parts[2], parts[4]]), Array(5).fill(['EVAL', '1', '4200']))
  assert.notEqual(calls[0]![3], calls[3]![3])
  assert.equal(calls[0]![3]!.includes('message-a'), false)
})

test('QQ主动流序号独立10分钟，无Redis时明确失败且不返回本地fallback', async () => {
  let calls = 0
  const sequences = createQqReplySequences({ async sendCommand(parts) { calls++; assert.equal(parts[4], '600'); throw new Error('合成敏感异常') } }, { ownerId: 'owner-a', botId: '7' })
  await assert.rejects(sequences.nextStream({ botId: '7', ttlSeconds: 600 }), /持久回复序号不可用/)
  await assert.rejects(sequences.nextPassive({ botId: '8', messageId: 'message', ttlSeconds: 4200 }), /作用域不匹配/)
  assert.equal(calls, 1)
})
