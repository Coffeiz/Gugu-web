import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunEvent, RunIdentity } from '@gugu/core/agent'
import { createAgentChatService } from '../../src/domains/agent-sessions/agent-chat-service.js'
import { createAgentRunEventStream } from '../../src/domains/agent-sessions/agent-run-event-stream.js'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
function event(sequence: number, type: RunEvent['type'], payload: RunEvent['payload'] = {}): RunEvent { return { id: `${sequence}`, identity, sequence, round: 1, type, payload } }
function setup(mode: 'final' | 'waiting' | 'failure') {
  let rows: RunEvent[] = [], state: { sequence: number; status: string } | null = null, notifications = 0
  const events = createAgentRunEventStream({ readEventsAfter: async (_id, seq) => rows.filter(row => row.sequence > seq), readState: async () => state },
    { publish: async () => { notifications++; return 0 } }, async () => ({ next: async signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })), close: async () => {} }), 2)
  const service = createAgentChatService({
    harness: { async *start() {
      if (mode === 'failure') throw new Error('synthetic secret')
      rows = [event(1, mode === 'waiting' ? 'interaction_required' : 'final', mode === 'final' ? { status: 'completed' } : {})]
      state = { sequence: 1, status: mode === 'waiting' ? 'waiting' : 'completed' }
      yield rows[0]!; return {} as never
    }, async cancel() { return true } },
    cancellation: { async request() {}, async notify() {} }, events,
    projection: { async interaction() { return { type: 'interaction_required' } } },
    async failStart() { if (!state) state = { sequence: 0, status: 'startup_failed' } },
    async prepare() { return { identity, userMessageId: 42 } }, async active(owner, id) { return owner === identity.ownerId && id === 7 ? { identity } : null },
  })
  return { service, notifications: () => notifications }
}
async function collect(stream: AsyncIterable<unknown>) { const result = []; for await (const item of stream) result.push(item); return result }
test('后台执行后从 outbox 投影，同一运行可重连重放', async () => {
  const { service, notifications } = setup('final')
  const initial = await collect(await service.start('owner-a', { message: '你好', client_message_id: 'client-1' }, undefined))
  assert.deepEqual(initial.map((item: any) => item.type), ['session_id', 'done'])
  assert.deepEqual(initial[0], { type: 'session_id', session_id: 7, user_message_id: 42, client_message_id: 'client-1' })
  const replay = await collect((await service.resume('owner-a', 7))!)
  assert.deepEqual(replay.map((item: any) => item.type), ['done']); assert.ok(notifications() > 0)
  assert.equal(await service.resume('owner-b', 7), null)
})
test('等待交互时投影已提交事件并结束当前流', async () => {
  const { service } = setup('waiting')
  const result = await collect(await service.start('owner-a', { message: '你好' }, undefined))
  assert.deepEqual(result.map((item: any) => item.type), ['session_id', 'interaction_required', 'done'])
})
test('创建 checkpoint 前失败输出脱敏错误与终态', async () => {
  const { service } = setup('failure')
  const result = await collect(await service.start('owner-a', { message: '你好' }, undefined))
  assert.deepEqual(result.map((item: any) => item.type), ['session_id', 'error', 'done'])
  assert.equal(JSON.stringify(result).includes('synthetic secret'), false)
})

test('checkpoint 尚未创建时取消仍先写入该 run 的持久标记', async () => {
  const actions: string[] = []
  const service = createAgentChatService({
    harness: { async *start() { return {} as never }, async cancel() { return false } },
    cancellation: { async request(id) { assert.deepEqual(id, identity); actions.push('request') }, async notify(id) { assert.deepEqual(id, identity); actions.push('notify') } },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    projection: { async interaction() { return { type: 'interaction_required' } } }, async failStart() {},
    async prepare() { return { identity, userMessageId: 42 } }, async active() { return { identity } },
  })
  assert.equal((await service.cancel('owner-a', 7))?.outcome, 'requested')
  assert.deepEqual(actions, ['request', 'notify'])
})

test('订阅断开不取消后台运行，取消请求限制当前用户', async () => {
  let release!: () => void, finished!: () => void, cancelled: RunIdentity | undefined
  const gate = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finished = resolve })
  const service = createAgentChatService({
    harness: { async *start() { await gate; finished(); return {} as never }, async cancel(id) { cancelled = id; return true } },
    cancellation: { async request() {}, async notify() {} },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    projection: { async interaction() { return { type: 'interaction_required' } } }, async failStart() {},
    async prepare() { return { identity, userMessageId: 42 } }, async active(owner, id) { return owner === identity.ownerId && id === 7 ? { identity } : null },
  })
  const iterator = (await service.start('owner-a', { message: '你好' }, undefined))[Symbol.asyncIterator]()
  await iterator.next(); await iterator.return?.()
  assert.equal((await service.cancel('owner-a', 7))?.outcome, 'requested'); assert.deepEqual(cancelled, identity)
  assert.equal(await service.cancel('owner-b', 7), null)
  release(); await done
})

test('调度模式不直接启动 Harness，早期取消写 selected 后标记同一 run', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'selected' }, order: string[] = []
  const service = createAgentChatService({
    harness: { async *start() { throw new Error('不得直接启动') }, async cancel(id) { assert.deepEqual(id, identity); order.push('cancel'); return false } },
    cancellation: { async request(id) { assert.deepEqual(id, identity); order.push('marker') }, async notify() { order.push('notify') } },
    async prepare() { return { identity, userMessageId: 4 } }, async active() { return { identity: null } },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    projection: { async interaction() { return { type: 'interaction_required' } } }, async failStart() {},
    dispatch: { async notify() { order.push('wake') }, diagnose() {}, async kick() { order.push('kick') }, async requestCancel() { order.push('selected'); return identity } },
  })
  const stream = await service.start('owner', { message: '合成' }, undefined)
  const it = stream[Symbol.asyncIterator]()
  assert.equal((await it.next()).value?.user_message_id, 4)
  assert.equal((await service.cancel('owner', 1))?.outcome, 'requested')
  assert.deepEqual(order, ['wake', 'kick', 'selected', 'cancel', 'marker', 'notify'])
})
