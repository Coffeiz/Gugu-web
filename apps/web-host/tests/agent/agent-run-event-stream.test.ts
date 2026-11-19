import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRunEventStream } from '../../src/modules/agent-sessions/agent-run-event-stream.js'
import { projectAgentRunEvent } from '../../src/modules/agent-sessions/agent-run-events.js'
import type { RunEvent } from '@gugu/core/agent'
const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
function event(sequence: number, type: RunEvent['type']): RunEvent { return { identity, id: `e${sequence}`, sequence, type, round: 0, payload: {} } }
test('重建阻塞提示不伪装已提交终态，重连仍从原持久序号继续', async () => {
  const stream = createAgentRunEventStream({ readEventsAfter: async () => [], readState: async () => ({ sequence: 4, status: 'reconstruction_version_conflict' }) }, { publish: async () => 0 }, async () => ({ next: async () => null, close: async () => {} }))
  const received: RunEvent[] = []
  for await (const item of await stream.open(identity, 4)) received.push(item)
  assert.equal(received.length, 1); assert.equal(received[0]?.sequence, 4); assert.equal(received[0]?.type, 'provider_diagnostic')
  const projected = await projectAgentRunEvent(received[0]!, { interaction: async () => ({ type: 'interaction' }) })
  assert.deepEqual(projected.map(item => item.type), ['error', 'done']); assert.equal(projected[0]?.recoverable, true)
})
test('丢失 Redis 通知仍可重放提交的事件及终态，重连从序号继续', async () => {
  let events: RunEvent[] = [], closed = 0
  const stream = createAgentRunEventStream({
    readEventsAfter: async (_identity, sequence) => events.filter(item => item.sequence > sequence),
    readState: async () => events.length ? { sequence: events.length, status: events.at(-1)?.type === 'final' ? 'completed' : 'running' } : null,
  }, { publish: async () => 0 }, async () => ({ next: async signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }) }), close: async () => { closed++ } }), 5)
  const iterator = (await stream.open(identity))[Symbol.asyncIterator]()
  const pending = iterator.next()
  events = [event(1, 'run_started'), event(2, 'final')]
  assert.equal((await pending).value?.sequence, 1)
  assert.equal((await iterator.next()).value?.sequence, 2)
  assert.equal((await iterator.next()).done, true)
  const replay: number[] = []
  for await (const item of await stream.open(identity, 1)) replay.push(item.sequence)
  assert.deepEqual(replay, [2]); assert.equal(closed, 2)
})
test('拒绝不属于运行身份的持久事件', async () => {
  const wrong = { ...event(1, 'final'), identity: { ...identity, ownerId: 'owner-b' } }
  const stream = createAgentRunEventStream({ readEventsAfter: async () => [wrong], readState: async () => null }, { publish: async () => 0 }, async () => ({ next: async () => null, close: async () => {} }))
  const iterator = (await stream.open(identity))[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), /顺序无效/)
})

test('重放跨越分页时继续读取直到终态，不等待通知', async () => {
  const all = Array.from({ length: 600 }, (_, i) => event(i + 1, i === 599 ? 'final' : 'run_started'))
  let reads = 0
  const stream = createAgentRunEventStream({ readEventsAfter: async (_id, seq) => { reads++; return all.slice(seq, seq + 256) }, readState: async () => ({ sequence: 600, status: 'completed' }) }, { publish: async () => 0 }, async () => ({ next: async () => { throw new Error('不应等待通知') }, close: async () => {} }))
  const received: number[] = []
  for await (const item of await stream.open(identity)) received.push(item.sequence)
  assert.equal(received.length, 600); assert.equal(received.at(-1), 600); assert.equal(reads, 3)
})
