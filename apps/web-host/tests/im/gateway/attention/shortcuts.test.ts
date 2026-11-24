import assert from 'node:assert/strict'
import test from 'node:test'
import { forgetMemoryEdit } from '@gugu/core/tools'
import { normalizeImWorkspaceArgument, parseImWorkspaceDeletion, runImAutomaticModeCommand, runImForgetCommand } from '@gugu/core/im/shortcut'
import { createImInboundPreflight } from '@gugu/gateway'
import type { ImPreflightPorts, ImPreflightScope } from '@gugu/gateway'
import { createImShortcutControls } from '../../../../src/modules/im/gateway/attention/shortcuts.js'
import { ImShortcutUnavailable } from '../../../../src/modules/im/gateway/attention/receipts.js'

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
  assert.equal(await createImInboundPreflight(ports)({ scope, text: '/stop', hasPendingMedia: false, botMentioned: true }, signal), 'consumed')
  assert.equal(current, 'run-b'); assert.equal(cancelled, 'run-a'); assert.deepEqual(replies, ['🛑 已停止当前任务'])
})
test('非发起人和缺目标证明不能调用取消，闲时ACK/进度仍进Run', async () => {
  let calls = 0
  const controls = createImShortcutControls({ state: { async read() { return { state: 'thinking', awaiting: false, initiatorIds: ['other'] } }, async cancel() { calls++; return true } }, diagnose() {} })
  assert.equal((await controls.decideShortcut(scope, '/stop', signal)).action, 'no_permission'); assert.equal(calls, 0)
  const idle = createImShortcutControls({ state: { async read() { return { state: 'idle', awaiting: false, initiatorIds: [] } }, async cancel() { throw new Error('闲时不取消') } }, diagnose() {} })
  for (const text of ['嗯', '谢谢', '查到了吗', '请解释取消订阅的影响']) assert.deepEqual(await idle.decideShortcut(scope, text, signal), { action: 'run' })
})
test('显式命令遇到状态不可用也直接回复，帮助不依赖状态读取', async () => {
  const notices: string[] = []
  const controls = createImShortcutControls({ state: { async read() { throw new ImShortcutUnavailable() }, async cancel() { return false } }, diagnose: code => { notices.push(code) } })
  assert.equal((await controls.decideShortcut(scope, '/stop', signal)).action, 'reply')
  const help = await controls.decideShortcut(scope, '/help', signal)
  assert.match('reply' in help ? help.reply : '', /当前入口可用命令/)
  assert.deepEqual(notices, ['shortcut_read_unavailable'])
  const failed = createImShortcutControls({ state: { async read() { throw new Error('合成程序缺陷') }, async cancel() { return false } }, diagnose() {} })
  await assert.rejects(failed.decideShortcut(scope, '/stop', signal), /合成程序缺陷/)
  const controller = new AbortController(), reason = new Error('合成停止'); controller.abort(reason)
  await assert.rejects(controls.decideShortcut(scope, '/stop', controller.signal), error => error === reason)
})
test('未接会话整理明确返回缺口且默认help不宣传，不伪造压缩或取消成功', async () => {
  const notices: string[] = []
  const controls = createImShortcutControls({ state: { async read() { return { state: 'idle', awaiting: false, initiatorIds: [] } }, async cancel() { throw new Error('不应取消') } }, diagnose: code => { notices.push(code) } })
  const compact = await controls.decideShortcut(scope, '/compact', signal)
  assert.equal(compact.action, 'reply'); assert.match('reply' in compact ? compact.reply : '', /尚未提供/)
  assert.deepEqual(notices, [])
  const help = await controls.decideShortcut(scope, '/help', signal)
  assert.doesNotMatch('reply' in help ? help.reply : '', /\/compact/)
})

test('IM 快捷层收到宿主完整能力清单时，列表和单命令帮助都不退化为快捷命令子集', async () => {
  const available = ['stop', 'status', 'goal', 'new', 'compact', 'memory', 'forget', 'workspace', 'auto', 'help']
  const controls = createImShortcutControls({ state: {
    async read() { throw new ImShortcutUnavailable() }, async cancel() { return false },
  }, helpCommands: available, diagnose() {} })
  const all = await controls.decideShortcut(scope, '/help', signal)
  const workspace = await controls.decideShortcut(scope, '/workspace help', signal)
  assert.equal(all.action, 'reply')
  assert.equal(workspace.action, 'reply')
  if (all.action === 'reply') for (const name of available) assert.match(all.reply, new RegExp(`/${name}(?:\\s|　)`))
  if (workspace.action === 'reply') assert.match(workspace.reply, /\/workspace delete/u)
})

test('已接compact执行真实端口并返回结果，help仅显示帮助不调用整理',async()=>{
  let calls=0
  const controls=createImShortcutControls({state:{async read(){return{state:'idle',awaiting:false,initiatorIds:[]}},async cancel(){return false}},async compact(actual,actualSignal){assert.deepEqual(actual,scope);assert.equal(actualSignal,signal);calls++;return '上下文已经整理好了，旧对话已压缩为摘要。'},diagnose(){}})
  assert.match((await controls.decideShortcut(scope,'/compact',signal) as {reply:string}).reply,/已经整理/);assert.equal(calls,1)
  assert.match((await controls.decideShortcut(scope,'/compact help',signal) as {reply:string}).reply,/立即整理/);assert.equal(calls,1)
})

test('自动模式无参只读，写入要求 Bot 所有者且开启受管理员配置控制', async () => {
  let current = false
  const writes: boolean[] = []
  const preferences = {
    async read() { return current },
    async write(enabled: boolean) { writes.push(enabled); current = enabled; return current },
  }
  const owner = { ...preferences, owner: true, enabled: true }
  assert.match(await runImAutomaticModeCommand('', { ...owner, owner: false }), /已关闭/u)
  assert.match(await runImAutomaticModeCommand('on', { ...owner, owner: false }), /只有绑定 Bot/u)
  assert.match(await runImAutomaticModeCommand('开启', { ...owner, enabled: false }), /未开放/u)
  assert.deepEqual(writes, [])
  assert.match(await runImAutomaticModeCommand('开', owner), /已开启/u)
  assert.match(await runImAutomaticModeCommand('状态', owner), /已开启/u)
  assert.match(await runImAutomaticModeCommand('关闭', { ...owner, enabled: false }), /已关闭/u)
  assert.deepEqual(writes, [true, false])
})

test('/forget 复用旧版两个字符的子串匹配，普通成员不能删除', async () => {
  const memory = [{ text: '小北喜欢咖啡' }, { text: '小北上午跑步' }]
  const edit = (query: string) => forgetMemoryEdit(memory, 'profile', query)
  assert.deepEqual(edit('咖啡').rows, [memory[1]])
  assert.equal(edit('咖').value.removed, 0)
  let writes = 0
  const forget = async (query: string) => { writes++; return edit(query).value.removed }
  await runImForgetCommand('咖啡', false, forget)
  await runImForgetCommand('！咖', true, forget)
  assert.equal(writes, 0)
  assert.match(await runImForgetCommand('咖啡', true, forget), /1 条记忆/u)
})

test('删除工作区要求稳定数字编号和显式确认', () => {
  assert.deepEqual(parseImWorkspaceDeletion('delete 7'), { kind: 'prompt', id: 7 })
  assert.deepEqual(parseImWorkspaceDeletion('rm 7 确认'), { kind: 'confirmed', id: 7 })
  assert.deepEqual(parseImWorkspaceDeletion('remove 7 cancel'), { kind: 'usage' })
  assert.deepEqual(parseImWorkspaceDeletion('delete 9007199254740993 confirm'), { kind: 'usage' })
  assert.equal(parseImWorkspaceDeletion('list'), null)
})

test('工作区无参数查看绑定，旧解绑别名兼容且目录名保持原样', () => {
  assert.equal(normalizeImWorkspaceArgument(''), 'show')
  assert.equal(normalizeImWorkspaceArgument('LIST'), 'list')
  for (const alias of ['OFF', 'none', 'unbind', 'unlink']) assert.equal(normalizeImWorkspaceArgument(alias), 'unlink')
  assert.equal(normalizeImWorkspaceArgument('bind Test Workspace'), 'bind Test Workspace')
  assert.equal(normalizeImWorkspaceArgument('GOD AbC'), 'god AbC')
})
