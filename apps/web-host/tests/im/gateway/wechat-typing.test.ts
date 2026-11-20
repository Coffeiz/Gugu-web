import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunEvent } from '@gugu/core/agent'
import type { ProviderTransport } from '@gugu/core/providers'
import { createILinkClient } from '@gugu/gateway/wechat'
import { createWechatTypingIndicator, createWechatTypingTicketCache, WECHAT_TICKET_TTL_MS } from '@gugu/gateway/wechat'
import { createWechatSender } from '../../../src/modules/im/gateway/platforms/wechat/sender.js'

const target = { userId: 'wx-synthetic', contextToken: 'synthetic-context' }
const identity = { ownerId: 'owner-synthetic', sessionId: '19', runId: 'run-synthetic' }
const event = (type: RunEvent['type'], sequence: number): RunEvent => ({ id: `event-${sequence}`, identity, type, sequence, round: 0, payload: {} })
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(r => setImmediate(r)) }; assert.ok(check(), '预期typing状态未出现') }
function clock() {
  const waits: Array<{ resolve(): void; reject(error: Error): void; signal: AbortSignal }> = []
  return { waits, sleep: (ms: number, signal: AbortSignal) => { assert.equal(ms, 5000); return new Promise<void>((resolve, reject) => {
    const entry = { resolve: () => { signal.removeEventListener('abort', abort); resolve() }, reject, signal }
    const abort = () => reject(new Error('合成停止')); signal.addEventListener('abort', abort, { once: true }); waits.push(entry)
  }) }, step: () => { waits.shift()!.resolve() } }
}
function adapters() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [], reports: string[] = []
  let configFailure = false, offFailure = false
  const transport: ProviderTransport = { async request(input) {
    const method = input.url.split('/').at(-1)!, body = JSON.parse(Buffer.from(input.body as Uint8Array).toString())
    calls.push({ method, body })
    if (method === 'getconfig' && configFailure) throw new Error('synthetic-secret-config')
    const value = method === 'getconfig' ? { ret: 0, typing_ticket: `synthetic-ticket-${body.ilink_user_id}` }
      : method === 'sendtyping' && body.status === 2 && offFailure ? { ret: -1 } : { ret: 0 }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} }
  }, async close() {} }
  const client = createILinkClient({ botToken: 'synthetic-bot-token', transport })
  return { client, calls, reports, failConfig: () => { configFailure = true }, failOff: () => { offFailure = true } }
}
test('真实getconfig缓存按用户隔离，12–24h抖动刷新失败保留旧ticket并指数退避', async () => {
  const f = adapters(); let now = 1000
  const cache = createWechatTypingTicketCache(f.client, { now: () => now, random: () => 0.5, report: code => f.reports.push(code) })
  assert.deepEqual(await cache.get(target.userId, target.contextToken), { status: 'ready', ticket: `synthetic-ticket-${target.userId}`, stale: false })
  await cache.get(target.userId, 'new-context')
  assert.equal(f.calls.length, 1)
  await cache.get('other-user', 'other-context'); assert.equal(f.calls.length, 2)
  now += WECHAT_TICKET_TTL_MS * 0.75 + 1; f.failConfig()
  assert.deepEqual(await cache.get(target.userId, target.contextToken), { status: 'ready', ticket: `synthetic-ticket-${target.userId}`, stale: true })
  const count = f.calls.length; now += 3999; await cache.get(target.userId, target.contextToken); assert.equal(f.calls.length, count)
  now++; await cache.get(target.userId, target.contextToken); assert.equal(f.calls.length, count + 1)
  assert.ok(f.reports.every(value => value === 'ticket-unavailable'))
  await cache.close(); await f.client.close()
})
test('首次失败2秒重试，API明确无ticket按成功TTL缓存，不冒充可用typing', async () => {
  let now = 0, calls = 0, failed = true
  const cache = createWechatTypingTicketCache({ getConfig: async () => { calls++; if (failed) throw new Error('synthetic-secret'); return { ret: 0 } } }, { now: () => now, random: () => 0 })
  assert.deepEqual(await cache.get('user'), { status: 'unavailable', reason: 'api_failed' })
  now = 1999; await cache.get('user'); assert.equal(calls, 1)
  now = 2000; failed = false; assert.deepEqual(await cache.get('user'), { status: 'unavailable', reason: 'empty_ticket' })
  now += WECHAT_TICKET_TTL_MS * 0.5 - 1; await cache.get('user'); assert.equal(calls, 2)
  await cache.close()
})
test('连续配置失败指数增长至一小时后保持上限，不在退避窗口重复请求', async () => {
  let now = 0, calls = 0, wait = 2000
  const cache = createWechatTypingTicketCache({ getConfig: async () => { calls++; throw new Error('合成配置失败') } }, { now: () => now })
  await cache.get('user')
  for (let i = 0; i < 14; i++) {
    const before = calls; now += wait - 1; await cache.get('user'); assert.equal(calls, before)
    now++; await cache.get('user'); assert.equal(calls, before + 1); wait = Math.min(wait * 2, 3600_000)
  }
  const before = calls; now += 3600_000 - 1; await cache.get('user'); assert.equal(calls, before)
  now++; await cache.get('user'); assert.equal(calls, before + 1)
  await cache.close()
})
test('500ms超时计入首次退避，主动caller取消不写失败且下一次可立即获取', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, now = 0, block = true
  const cache = createWechatTypingTicketCache({ getConfig: async (_user, _context, signal) => {
    calls++
    if (!block) return { ret: 0, typing_ticket: 'synthetic-ticket' }
    return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true }) })
  } }, { now: () => now })
  const timed = cache.get('timed-user')
  context.mock.timers.tick(500)
  assert.deepEqual(await timed, { status: 'unavailable', reason: 'api_failed' })
  now = 1999; await cache.get('timed-user'); assert.equal(calls, 1)
  const controller = new AbortController(), reason = new Error('合成调用者取消')
  const aborted = cache.get('cancelled-user', '', controller.signal); controller.abort(reason)
  await assert.rejects(aborted, error => error === reason)
  block = false
  assert.deepEqual(await cache.get('cancelled-user'), { status: 'ready', ticket: 'synthetic-ticket', stale: false })
  assert.equal(calls, 3); await cache.close()
})
test('实际sendtyping立即ON和5秒保活，撤权后OFF且不再ON，重复start/stop不重复发送', async () => {
  const f = adapters(), time = clock(); let authorized = true, checks = 0
  const indicator = createWechatTypingIndicator({ client: f.client, userId: target.userId, ticket: 'synthetic-ticket', sleep: time.sleep,
    authorize: async () => { checks++; return authorized } })
  await indicator.start(); await until(() => time.waits.length === 1)
  await indicator.start(); assert.deepEqual(f.calls.map(call => call.body.status), [1])
  time.step(); await until(() => time.waits.length === 1)
  authorized = false; time.step(); await until(() => f.calls.length === 3)
  assert.deepEqual(f.calls.map(call => call.body.status), [1, 1, 2]); assert.equal(checks, 3)
  assert.equal(await indicator.stop(), 'stopped'); assert.equal(await indicator.stop(), 'stopped')
  assert.equal(f.calls.length, 3); await f.client.close()
})
test('stop等待在途ON取消排空，之后OFF使用未取消的独立signal', async () => {
  const order: string[] = []
  const transport: ProviderTransport = { request: async (input, signal) => {
    const body = JSON.parse(Buffer.from(input.body as Uint8Array).toString())
    if (body.status === 1) { order.push('on-start'); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { order.push('on-aborted'); reject(new Error('synthetic-secret')) }, { once: true }) }) }
    assert.equal(signal.aborted, false); order.push('off')
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"ret":0}') })(), cancel() {} }
  }, async close() {} }
  const client = createILinkClient({ botToken: 'synthetic-token', transport })
  const indicator = createWechatTypingIndicator({ client, userId: target.userId, ticket: 'synthetic-ticket', authorize: async () => true })
  await indicator.start(); await until(() => order.length === 1)
  assert.equal(await indicator.stop(), 'stopped'); assert.deepEqual(order, ['on-start', 'on-aborted', 'off'])
  await client.close()
})
test('OFF有独立五秒边界，结果未知不假称已停止，typing错误只报告固定码', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const time = clock(), reports: string[] = []; let offSignal: AbortSignal | undefined
  const indicator = createWechatTypingIndicator({ userId: target.userId, ticket: 'synthetic-ticket', authorize: async () => true,
    client: { sendTyping: async (_user, _ticket, status, signal) => { if (status === 1) return { ret: 0 }; offSignal = signal; return new Promise(() => {}) } },
    sleep: time.sleep, report: code => reports.push(code) })
  await indicator.start(); await until(() => time.waits.length === 1)
  const stopped = indicator.stop(); await until(() => !!offSignal)
  assert.equal(offSignal!.aborted, false); context.mock.timers.tick(5000)
  assert.equal(await stopped, 'unknown'); assert.equal(offSignal!.aborted, true)
  assert.deepEqual(reports, ['typing-stop-unavailable'])
})
test('observeRun只迭代实际事件一次，业务开始前无ON，等待交互/最终回复先OFF', async () => {
  const f = adapters(), time = clock(), sender = createWechatSender({ client: f.client, media: { prepareItem: async () => { throw new Error('不应上传') } }, typing: { sleep: time.sleep } })
  let iterations = 0
  const actual = [event('run_started', 1), event('token', 2), event('interaction_required', 3), event('run_resumed', 4), event('final', 5)]
  const source = { async *[Symbol.asyncIterator]() { iterations++; yield* actual } }
  const wrapped = sender.observeRun(target, source, async () => true)
  assert.equal(iterations, 0); assert.equal(f.calls.length, 0)
  assert.equal((await wrapped.next()).value, actual[0]); await until(() => time.waits.length === 1)
  assert.equal((await wrapped.next()).value, actual[1])
  assert.equal((await wrapped.next()).value, actual[2]); assert.equal(f.calls.at(-1)!.body.status, 2)
  assert.equal((await wrapped.next()).value, actual[3]); await until(() => f.calls.filter(call => call.body.status === 1).length === 2)
  assert.equal((await wrapped.next()).value, actual[4]); assert.equal(f.calls.at(-1)!.body.status, 2)
  assert.equal((await wrapped.next()).done, true); assert.equal(iterations, 1)
  await sender.close(); await f.client.close()
})
test('业务生成器yield后抛出的原错误在OFF失败时仍原样抛出，不被typing吞掉', async () => {
  const f = adapters(), time = clock(), sender = createWechatSender({ client: f.client, media: { prepareItem: async () => { throw new Error('不应上传') } }, typing: { sleep: time.sleep } })
  const original = new Error('合成业务失败')
  async function* business() { yield event('run_started', 1); throw original }
  const observed = sender.observeRun(target, business(), async () => true)
  await observed.next(); await until(() => time.waits.length === 1); f.failOff()
  await assert.rejects(observed.next(), error => error === original)
  assert.equal(f.calls.at(-1)!.body.status, 2)
  await sender.close(); await f.client.close()
})
test('真实sender文本发出前先OFF；缺typing API明确not_configured并保留普通发送', async () => {
  const f = adapters(), time = clock(), sender = createWechatSender({ client: f.client, media: { prepareItem: async () => { throw new Error('不应上传') } }, typing: { sleep: time.sleep } })
  assert.equal((await sender.startTyping(target, async () => true)).status, 'started')
  await until(() => time.waits.length === 1)
  assert.equal((await sender.text(target, '合成回复')).outcome, 'accepted')
  assert.deepEqual(f.calls.map(call => call.method === 'sendtyping' ? call.body.status : call.method), ['getconfig', 1, 2, 'sendmessage'])
  const noTyping = createWechatSender({ client: { sendMessage: async () => ({ ret: 0 }) }, media: { prepareItem: async () => { throw new Error('不应上传') } } })
  assert.deepEqual(await noTyping.startTyping(target, async () => true), { status: 'unavailable', reason: 'not_configured' })
  assert.equal((await noTyping.text(target, '合成回复')).outcome, 'accepted')
  await noTyping.close(); await sender.close(); await f.client.close()
})
test('可信预取ticket只需sendTyping端口；未授权时不查配置也不发ON', async () => {
  const time = clock(), statuses: number[] = []
  const sender = createWechatSender({ client: { sendMessage: async () => ({ ret: 0 }), sendTyping: async (_user, ticket, status) => { assert.equal(ticket, 'trusted-prefetched-ticket'); statuses.push(status); return { ret: 0 } } },
    media: { prepareItem: async () => { throw new Error('不应上传') } }, typing: { sleep: time.sleep } })
  assert.deepEqual(await sender.startTyping({ ...target, typingTicket: 'trusted-prefetched-ticket' }, async () => false), { status: 'unavailable', reason: 'unauthorized' })
  assert.deepEqual(statuses, [])
  assert.equal((await sender.startTyping({ ...target, typingTicket: 'trusted-prefetched-ticket' }, async () => true)).status, 'started')
  await until(() => time.waits.length === 1); await sender.close()
  assert.deepEqual(statuses, [1, 2])
})
test('撤权自行结束的indicator不能冒充仍运行，后续重新授权的新Run实际重新ON', async () => {
  const f = adapters(), time = clock(); let allowed = true
  const sender = createWechatSender({ client: f.client, media: { prepareItem: async () => { throw new Error('不应上传') } }, typing: { sleep: time.sleep } })
  const first = await sender.startTyping(target, async () => allowed)
  assert.equal(first.status, 'started'); if (first.status !== 'started') throw new Error('typing未启动')
  await until(() => time.waits.length === 1)
  allowed = false; time.step(); await until(() => !first.indicator.isRunning())
  allowed = true
  assert.equal((await sender.startTyping(target, async () => allowed)).status, 'started')
  await until(() => f.calls.filter(call => call.body.status === 1).length === 2)
  assert.deepEqual(f.calls.filter(call => call.method === 'sendtyping').map(call => call.body.status), [1, 2, 1])
  await sender.close(); await f.client.close()
})
