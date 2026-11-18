import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunEvent, RunIdentity } from '@gugu/core/agent'
import { createAgentChatService } from '@gugu/core/agent'
import { createAgentRunEventStream } from '../../src/domains/agent-sessions/agent-run-event-stream.js'
import { projectAgentRunEvent } from '../../src/domains/agent-sessions/agent-run-events.js'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
function event(sequence: number, type: RunEvent['type'], payload: RunEvent['payload'] = {}): RunEvent { return { id: `${sequence}`, identity, sequence, round: 1, type, payload } }
const project = (event: RunEvent) => projectAgentRunEvent(event, { async interaction() { return { type: 'interaction_required' } } })
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
    project,
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
    project, async failStart() {},
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
    project, async failStart() {},
    async prepare() { return { identity, userMessageId: 42 } }, async active(owner, id) { return owner === identity.ownerId && id === 7 ? { identity } : null },
  })
  const iterator = (await service.start('owner-a', { message: '你好' }, undefined))[Symbol.asyncIterator]()
  await iterator.next(); await iterator.return?.()
  assert.equal((await service.cancel('owner-a', 7))?.outcome, 'requested'); assert.deepEqual(cancelled, identity)
  assert.equal(await service.cancel('owner-b', 7), null)
  release(); await done
})

test('调度模式不直接启动 Harness，早期取消写 selected 与运行时标记后唤醒 worker', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'selected' }, order: string[] = []
  const service = createAgentChatService({
    harness: { async *start() { throw new Error('不得直接启动') }, async cancel(id) { assert.deepEqual(id, identity); order.push('cancel'); return false } },
    cancellation: { async request(id) { assert.deepEqual(id, identity); order.push('marker') }, async notify() { order.push('notify') } },
    async prepare() { return { identity, userMessageId: 4 } }, async active() { return { identity: null } },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    project, async failStart() {},
    dispatch: { async notify() { order.push('wake') }, diagnose() {}, async kick() { order.push('kick') }, async requestCancel() { order.push('selected'); return identity } },
  })
  const stream = await service.start('owner', { message: '合成' }, undefined)
  const it = stream[Symbol.asyncIterator]()
  assert.equal((await it.next()).value?.user_message_id, 4)
  assert.equal((await service.cancel('owner', 1))?.outcome, 'requested')
  assert.deepEqual(order, ['wake', 'kick', 'selected', 'marker', 'notify', 'wake'])
})

test('调度模式取消活动 Run 不调用无关 Harness，依次写取消标记并唤醒运行器', async () => {
  const actions: string[] = []
  const service = createAgentChatService({
    cancellation: { async request(id) { assert.deepEqual(id, identity); actions.push('marker') }, async notify(id) { assert.deepEqual(id, identity); actions.push('runtime-notify') } },
    async prepare() { return { identity, userMessageId: 42 } }, async active() { return { identity } },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    project, async failStart() {},
    dispatch: { async notify() { actions.push('dispatch-wake') }, diagnose() {}, async kick() {}, async requestCancel() { actions.push('persist-selected-cancel'); return identity } },
  })

  assert.equal((await service.cancel(identity.ownerId, Number(identity.sessionId)))?.outcome, 'requested')
  assert.deepEqual(actions, ['persist-selected-cancel', 'marker', 'runtime-notify', 'dispatch-wake'])
})

test('SSE 订阅取消只停止 outbox 读取，不取消持久 dispatch Run', async () => {
  const controller = new AbortController(), actions: string[] = []
  let openedSignal: AbortSignal | undefined
  const service = createAgentChatService({
    harness: { async *start() { actions.push('harness-start'); return {} as never }, async cancel() { actions.push('harness-cancel'); return true } },
    cancellation: { async request() { actions.push('cancel-request') }, async notify() {} },
    async prepare() { return { identity, userMessageId: 42 } },
    async active() { return { identity } },
    events: {
      async open(_identity, _afterSequence, signal) {
        openedSignal = signal
        return (async function* () {
          if (signal?.aborted) return
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        })()
      },
      async notify() {},
    },
    project,
    async failStart() {},
    dispatch: {
      async kick() { actions.push('dispatch-kick') }, async notify() {}, diagnose() {},
      async requestCancel() { actions.push('cancel-request'); return null },
    },
  })

  const iterator = (await service.start('owner-a', { message: '你好' }, undefined, controller.signal))[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, 'session_id')
  controller.abort()
  assert.equal((await iterator.next()).done, true)
  assert.equal(openedSignal, controller.signal)
  assert.deepEqual(actions, ['dispatch-kick'])
})

test('交互事务提交后只唤醒当前 owner 的活动 dispatch Run', async () => {
  const actions: string[] = []
  const service = createAgentChatService({
    cancellation: { async request() {}, async notify() {} },
    async prepare() { return { identity, userMessageId: 42 } },
    async active(owner, sessionId) { return owner === identity.ownerId && sessionId === Number(identity.sessionId) ? { identity } : null },
    events: { async open() { return (async function* () {})() }, async notify() {} },
    project, async failStart() {},
    dispatch: {
      async notify() { actions.push('notify') }, diagnose() {},
      async kick(owner, sessionId) { actions.push(`${owner}:${sessionId}`) },
      async requestCancel() { return null },
    },
  })

  assert.equal(await service.wake('owner-b', 7), false)
  assert.equal(await service.wake(identity.ownerId, Number(identity.sessionId)), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(actions, ['notify', `${identity.ownerId}:${identity.sessionId}`])
})
