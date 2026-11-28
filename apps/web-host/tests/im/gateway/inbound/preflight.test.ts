import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createImInboundPreflight, ImPreflightError, imSemanticText, selectImTextChoice,
  type ImPreflightMessage, type ImPreflightPorts } from '@gugu/gateway'

const signal = new AbortController().signal
const message = (overrides: Partial<ImPreflightMessage> = {}): ImPreflightMessage => ({
  scope: { ownerId: 'owner-a', botId: '4', platform: 'telegram', chatType: 'c2c', chatId: null, platformUserId: 'user-a', eventId: 'event-a' },
  text: '你好', hasPendingMedia: false, botMentioned: false, ...overrides,
})
function fixture(overrides: Partial<ImPreflightPorts> = {}) {
  const calls: string[] = [], replies: Array<{ text: string; quote: boolean }> = []
  const ports: ImPreflightPorts = {
    authorize: async () => { calls.push('authorize'); return true },
    inspectSecret: async () => { calls.push('secret'); return { status: 'none' } },
    applySecret: async (_scope, _reference, action) => { calls.push(`secret:${action.action}`); return { status: 'completed' } },
    bindQqOwnerIfUnbound: async () => { calls.push('qq-owner') },
    consumeBinding: async () => { calls.push('binding'); return true },
    consumeTextChoice: async () => { calls.push('choice'); return null },
    decideShortcut: async () => { calls.push('shortcut'); return { action: 'run' } },
    cancel: async () => { calls.push('cancel'); return true },
    reply: async (_scope, text, options) => { replies.push({ text, quote: options.quote }) }, ...overrides,
  }
  return { ports, calls, replies, run: createImInboundPreflight(ports) }
}
describe('IM 入站控制消息早于媒体、历史与普通队列', () => {
  it('先复核完整可信scope，撤权后不查秘密、不绑定、不回复', async () => {
    const f = fixture({ authorize: async scope => { assert.deepEqual(scope, message().scope); return false } })
    assert.equal(await f.run(message(), signal), 'consumed')
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.replies, [])
  })
  it('秘密值只交专用capture，引用媒体/表情也阻止值消费，且从不引用原消息', async () => {
    let value = ''
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }),
      applySecret: async (_scope, _reference, action) => { if (action.action === 'value') value = action.value; return { status: 'completed' } } })
    assert.equal(await f.run(message({ text: 'synthetic-secret' }), signal), 'consumed')
    assert.equal(value, 'synthetic-secret')
    assert.deepEqual(f.calls, ['authorize'])
    assert.deepEqual(f.replies, [{ text: '凭据已安全保存。', quote: false }])
    value = ''; await f.run(message({ text: 'synthetic-secret', hasPendingMedia: true }), signal)
    assert.equal(value, '')
    assert.equal(f.replies.at(-1)?.text.includes('纯文本'), true)
    assert.equal(JSON.stringify(f.replies).includes('synthetic-secret'), false)
  })
  it('已消费秘密事件静默吞掉；过期stage提示且不变成新一轮消息', async () => {
    for (const status of ['replay', 'ended'] as const) {
      const f = fixture({ inspectSecret: async () => ({ status }) })
      assert.equal(await f.run(message(), signal), 'consumed')
      assert.deepEqual(f.calls, ['authorize'])
      assert.equal(f.replies.length, status === 'replay' ? 0 : 1)
    }
  })
  it('pending choice仅开始/取消被消费，其他文字仍可正常排队', async () => {
    for (const [text, action] of [['1', 'start'], ['输入凭据', 'start'], ['2', 'cancel'], ['CANCEL', 'cancel']] as const) {
      let actual = ''
      const f = fixture({ inspectSecret: async () => ({ status: 'pending_choice', reference: 'synthetic-inspected-stage' }), applySecret: async (_s, _reference, input) => { actual = input.action; return { status: 'cancelled' } } })
      assert.equal(await f.run(message({ text }), signal), 'consumed')
      assert.equal(actual, action)
    }
    const f = fixture({ inspectSecret: async () => ({ status: 'pending_choice', reference: 'synthetic-inspected-stage' }) })
    assert.equal(await f.run(message({ text: '普通问题' }), signal), 'enqueue')
  })
  it('没有事件ID不得提交秘密；捕获异常不泄露原异常/秘密或继续普通消息', async () => {
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }), applySecret: async () => { throw new Error('synthetic-secret') } })
    assert.equal(await f.run(message({ text: 'synthetic-secret' }), signal), 'consumed')
    assert.equal(JSON.stringify(f.replies).includes('synthetic-secret'), false)
    assert.equal(await f.run(message({ scope: { ...message().scope, eventId: '' } }), signal), 'consumed')
    assert.equal(f.replies.at(-1)?.text.includes('无法确认'), true)
  })
  it('群聊不查私聊秘密stage；有待下载媒体不做文本交互和快捷取消', async () => {
    const f = fixture()
    assert.equal(await f.run(message({ scope: { ...message().scope, chatType: 'group', chatId: 'group-a' }, hasPendingMedia: true }), signal), 'enqueue')
    assert.deepEqual(f.calls, ['authorize'])
  })
  it('QQ秘密检查先于首次owner绑定及六位验证码，不从其他平台消费数字', async () => {
    let code = ''
    const f = fixture({ consumeBinding: async (_s, value) => { f.calls.push('binding'); code = value; return true } })
    assert.equal(await f.run(message({ scope: { ...message().scope, platform: 'qq' }, text: 'BiNd 123456', hasPendingMedia: true }), signal), 'consumed')
    assert.equal(code, '123456')
    assert.deepEqual(f.calls, ['authorize', 'secret', 'qq-owner', 'binding'])
    const ordinary = fixture()
    assert.equal(await ordinary.run(message({ text: '123456' }), signal), 'enqueue')
    assert.equal(ordinary.calls.includes('binding'), false)
  })
  it('Telegram只消费parser确认且定向当前Bot的bind，群命令不兑换码', async () => {
    let code = ''
    const f = fixture({ consumeBinding: async (_s, value) => { code = value; return false } })
    assert.equal(await f.run(message({ text: '/bind@gugu_bot 123456', telegramCommand: 'bind' }), signal), 'consumed')
    assert.equal(code, '123456')
    assert.equal(f.replies[0]?.text.includes('绑定码无效'), true)
    code = ''
    assert.equal(await f.run(message({ scope: { ...message().scope, chatType: 'group', chatId: 'group-a' }, telegramCommand: 'bind' }), signal), 'consumed')
    assert.equal(code, '')
  })
  it('等待输入/数字选项先于取消，保留正文并仅在可信mention时移除首个@', async () => {
    let semantic = ''
    const f = fixture({ consumeTextChoice: async (_s, text) => { semantic = text; return { status: 'awaiting_text' } } })
    const input = message({ text: '@咕咕 /stop', botMentioned: true })
    assert.equal(await f.run(input, signal), 'consumed')
    assert.equal(semantic, '/stop')
    assert.equal(input.text, '@咕咕 /stop')
    assert.equal(f.calls.includes('shortcut'), false)
    assert.equal(f.replies[0]?.text.includes('直接发送'), true)
    assert.equal(imSemanticText('@别人 /stop', false), '@别人 /stop')
  })
  it('只对真正落地的取消回成功，无权取消不调用取消端口', async () => {
    const f = fixture({ decideShortcut: async () => ({ action: 'cancel', reply: '已取消', reference: 'synthetic-exact-run' }),
      cancel: async (_scope, reference) => { assert.equal(reference, 'synthetic-exact-run'); return false } })
    assert.equal(await f.run(message({ text: '/stop' }), signal), 'consumed')
    assert.equal(f.replies[0]?.text.includes('尚未生效'), true)
    const denied = fixture({ decideShortcut: async () => ({ action: 'no_permission', reply: '不是你的任务' }) })
    await denied.run(message(), signal)
    assert.equal(denied.calls.includes('cancel'), false)
  })
  it('已提交交互的重放不重新回复或发起shortcut', async () => {
    const f = fixture({ consumeTextChoice: async () => ({ status: 'replay' }) })
    assert.equal(await f.run(message(), signal), 'consumed')
    assert.deepEqual(f.replies, [])
    assert.equal(f.calls.includes('shortcut'), false)
  })
  it('秘密capture竞态重放静默消费，业务失败不冒充保存成功', async () => {
    for (const status of ['replay', 'failed'] as const) {
      const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }), applySecret: async () => ({ status }) })
      assert.equal(await f.run(message({ text: 'synthetic-secret' }), signal), 'consumed')
      assert.equal(f.replies.length, status === 'replay' ? 0 : 1)
      assert.equal(JSON.stringify(f.replies).includes('已安全保存'), false)
    }
  })
  it('状态或授权异常只暴露静态错误；取消保留原signal原因，不继续绑定', async () => {
    const f = fixture({ inspectSecret: async () => { throw new Error('synthetic-secret') } })
    await assert.rejects(f.run(message(), signal), new ImPreflightError())
    const controller = new AbortController(), reason = new Error('停止')
    controller.abort(reason)
    await assert.rejects(f.run(message(), controller.signal), error => error === reason)
    assert.deepEqual(f.calls, ['authorize'])
  })
  it('secret apply必须收到inspect返回的同一引用和可信准入边界，缺引用不能转交值或普通排队', async () => {
    let reference = '', cutoff = ''
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'opaque-exact-observed-phase' }),
      applySecret: async (scope, token) => { reference = token; cutoff = scope.admissionCutoff!; return { status: 'completed' } } })
    const incoming = message({ scope: { ...message().scope, admissionCutoff: '2026-11-18T00:00:00.123456Z' }, text: 'synthetic-secret' })
    assert.equal(await f.run(incoming, signal), 'consumed')
    assert.equal(reference, 'opaque-exact-observed-phase')
    assert.equal(cutoff, incoming.scope.admissionCutoff)
    let submitted = false
    const broken = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret' } as never), applySecret: async () => { submitted = true; return { status: 'completed' } } })
    await assert.rejects(broken.run(incoming, signal), new ImPreflightError())
    assert.equal(submitted, false)
  })
})
describe('统一交互文本匹配不改变声明序号及确认门', () => {
  const prompt = { kind: 'choice', secret: false, allowTextInput: false, customInputActive: false,
    options: [{ id: 'gone', label: '已消费', token: null }, { id: 'keep', label: 'Straße', token: 'opaque-token' }] }
  it('全角序号/Unicode casefold匹配原选项；已消费项不会让后项挤到第一位', () => {
    assert.equal(selectImTextChoice(prompt, '１'), null)
    assert.deepEqual(selectImTextChoice(prompt, '２'), { action: 'option', token: 'opaque-token' })
    assert.deepEqual(selectImTextChoice(prompt, 'STRASSE'), { action: 'option', token: 'opaque-token' })
    assert.equal(selectImTextChoice({ ...prompt, secret: true }, '２'), null)
  })
  it('真实选项存在时先选自定义回复；无真实选项可直接回复，不能跳过秘密入口', () => {
    assert.equal(selectImTextChoice({ ...prompt, allowTextInput: true }, '任意回复'), null)
    assert.deepEqual(selectImTextChoice({ ...prompt, allowTextInput: true, customInputActive: true }, '任意回复'), { action: 'text' })
    assert.deepEqual(selectImTextChoice({ ...prompt, allowTextInput: true, options: [{ id: '__custom_reply__', label: '自定义', token: 'opaque' }] }, '任意回复'), { action: 'text' })
  })
})

it('可信 @Bot 后的斜杠命令提取命令正文，未确认的 @ 保留原文', () => {
  assert.equal(imSemanticText('@咕咕 助手 /workspace 1', true), '/workspace 1')
  assert.equal(imSemanticText('<@123>/help', true), '/help')
  assert.equal(imSemanticText('@咕咕 /workspace 1', false), '@咕咕 /workspace 1')
})

it('群里只有可信 @Bot 的命令进入命令端口', async () => {
  const seen: string[] = []
  const f = fixture({ decideShortcut: async (_scope, text) => {
    seen.push(text)
    return { action: 'reply', reply: '命令帮助' }
  } })
  const input = message({ scope: { ...message().scope, chatType: 'group', chatId: 'group-a' }, text: '@咕咕 助手 /help' })
  assert.equal(await createImInboundPreflight(f.ports)({ ...input, text: '/help' }, signal), 'enqueue')
  assert.equal(await createImInboundPreflight(f.ports)({ ...input, botMentioned: true }, signal), 'consumed')
  assert.equal(await createImInboundPreflight(f.ports)({ ...input, botMentioned: true, hasPendingMedia: true }, signal), 'consumed')
  assert.deepEqual(seen, ['/help', '/help'])
})
