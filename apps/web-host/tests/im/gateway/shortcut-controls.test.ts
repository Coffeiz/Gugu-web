import assert from 'node:assert/strict'
import test from 'node:test'
import { createImInboundPreflight } from '@gugu/core/im/inbound-preflight'
import type { ImPreflightPorts, ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { createImShortcutControls } from '../../../src/modules/im/gateway/shortcut-controls.js'
import { ImShortcutUnavailable } from '../../../src/modules/im/gateway/shortcut-postgres.js'

const scope: ImPreflightScope = { ownerId: 'owner-a', botId: '7', platform: 'telegram', chatType: 'group', chatId: 'group-a',
  platformUserId: 'sender-a', eventId: 'event-a', admissionCutoff: '2026-01-01 00:00:00.123456+00' }
const signal = new AbortController().signal
test('真实Core预检→快捷意图→冻结reference取消，不用稍后出现的新目标', async () => {
  let current = 'run-a', cancelled: string | null = null; const replies: string[] = []
  const controls = createImShortcutControls({ state: {
    async read() { const cancelReference = current; current = 'run-b'; return { state: 'thinking', awaiting: false, initiatorIds: ['sender-a'], cancelReference } },
    async cancel(actual, reference) { assert.deepEqual(actual, scope); cancelled = reference; return true },
  }, diagnose() { throw new Error('正常取消不应诊断失败') } })
  const ports: ImPreflightPorts = { ...controls, authorize: async () => true, inspectSecret: async () => ({ status: 'none' }),
    applySecret: async () => { throw new Error('群消息不进入秘密输入') }, bindQqOwnerIfUnbound: async () => {},
    consumeBinding: async () => false, consumeTextChoice: async () => null, reply: async (_scope, value) => { replies.push(value) } }
  assert.equal(await createImInboundPreflight(ports)({ scope, text: '/stop', hasPendingMedia: false, botMentioned: false }, signal), 'consumed')
  assert.equal(current, 'run-b'); assert.equal(cancelled, 'run-a'); assert.deepEqual(replies, ['🛑 已停止当前任务'])
})
test('非发起人和缺目标证明不能调用取消，闲时ACK/进度仍进Run', async () => {
  let calls = 0
  const controls = createImShortcutControls({ state: { async read() { return { state: 'thinking', awaiting: false, initiatorIds: ['other'] } }, async cancel() { calls++; return true } }, diagnose() {} })
  assert.equal((await controls.decideShortcut(scope, '/stop', signal)).action, 'no_permission'); assert.equal(calls, 0)
  const idle = createImShortcutControls({ state: { async read() { return { state: 'idle', awaiting: false, initiatorIds: [] } }, async cancel() { throw new Error('闲时不取消') } }, diagnose() {} })
  for (const text of ['嗯', '谢谢', '查到了吗', '请解释取消订阅的影响']) assert.deepEqual(await idle.decideShortcut(scope, text, signal), { action: 'run' })
})
test('仅明确快捷状态不可用回正常Run并诊断，未知程序错误和取消不被掩盖', async () => {
  const notices: string[] = []
  const controls = createImShortcutControls({ state: { async read() { throw new ImShortcutUnavailable() }, async cancel() { return false } }, diagnose: code => { notices.push(code) } })
  assert.deepEqual(await controls.decideShortcut(scope, '/stop', signal), { action: 'run' }); assert.deepEqual(notices, ['shortcut_read_unavailable'])
  const failed = createImShortcutControls({ state: { async read() { throw new Error('合成程序缺陷') }, async cancel() { return false } }, diagnose() {} })
  await assert.rejects(failed.decideShortcut(scope, '/stop', signal), /合成程序缺陷/)
  const controller = new AbortController(), reason = new Error('合成停止'); controller.abort(reason)
  await assert.rejects(controls.decideShortcut(scope, '/stop', controller.signal), error => error === reason)
})
test('未接会话整理明确返回缺口且默认help不宣传，不伪造压缩或取消成功', async () => {
  const notices: string[] = []
  const controls = createImShortcutControls({ state: { async read() { return { state: 'idle', awaiting: false, initiatorIds: [] } }, async cancel() { throw new Error('不应取消') } }, diagnose: code => { notices.push(code) } })
  const compact = await controls.decideShortcut(scope, '/compact', signal)
  assert.equal(compact.action, 'reply'); assert.match('reply' in compact ? compact.reply : '', /尚未接通/)
  assert.deepEqual(notices, ['compact_unavailable'])
  const help = await controls.decideShortcut(scope, '/help', signal)
  assert.doesNotMatch('reply' in help ? help.reply : '', /\/compact/)
})

test('已接compact执行真实端口并返回结果，help仅显示帮助不调用整理',async()=>{
  let calls=0
  const controls=createImShortcutControls({state:{async read(){return{state:'idle',awaiting:false,initiatorIds:[]}},async cancel(){return false}},async compact(actual,actualSignal){assert.deepEqual(actual,scope);assert.equal(actualSignal,signal);calls++;return '上下文已经整理好了，旧对话已压缩为摘要。'},diagnose(){}})
  assert.match((await controls.decideShortcut(scope,'/compact',signal) as {reply:string}).reply,/已经整理/);assert.equal(calls,1)
  assert.match((await controls.decideShortcut(scope,'/compact help',signal) as {reply:string}).reply,/立即整理/);assert.equal(calls,1)
})
