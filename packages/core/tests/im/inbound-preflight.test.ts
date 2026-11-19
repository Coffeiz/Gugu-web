import { describe, expect, it } from 'vitest'
import { createImInboundPreflight, ImPreflightError, imSemanticText, selectImTextChoice,
  type ImPreflightMessage, type ImPreflightPorts } from '../../src/im/inbound-preflight.js'

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
    const f = fixture({ authorize: async scope => { expect(scope).toEqual(message().scope); return false } })
    expect(await f.run(message(), signal)).toBe('consumed')
    expect(f.calls).toEqual([]); expect(f.replies).toEqual([])
  })
  it('秘密值只交专用capture，引用媒体/表情也阻止值消费，且从不引用原消息', async () => {
    let value = ''
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }),
      applySecret: async (_scope, _reference, action) => { if (action.action === 'value') value = action.value; return { status: 'completed' } } })
    expect(await f.run(message({ text: 'synthetic-secret' }), signal)).toBe('consumed')
    expect(value).toBe('synthetic-secret'); expect(f.calls).toEqual(['authorize'])
    expect(f.replies).toEqual([{ text: '凭据已安全保存。', quote: false }])
    value = ''; await f.run(message({ text: 'synthetic-secret', hasPendingMedia: true }), signal)
    expect(value).toBe(''); expect(f.replies.at(-1)?.text).toContain('纯文本')
    expect(JSON.stringify(f.replies)).not.toContain('synthetic-secret')
  })
  it('已消费秘密事件静默吞掉；过期stage提示且不变成新一轮消息', async () => {
    for (const status of ['replay', 'ended'] as const) {
      const f = fixture({ inspectSecret: async () => ({ status }) })
      expect(await f.run(message(), signal)).toBe('consumed')
      expect(f.calls).toEqual(['authorize']); expect(f.replies.length).toBe(status === 'replay' ? 0 : 1)
    }
  })
  it('pending choice仅开始/取消被消费，其他文字仍可正常排队', async () => {
    for (const [text, action] of [['1', 'start'], ['输入凭据', 'start'], ['2', 'cancel'], ['CANCEL', 'cancel']] as const) {
      let actual = ''
      const f = fixture({ inspectSecret: async () => ({ status: 'pending_choice', reference: 'synthetic-inspected-stage' }), applySecret: async (_s, _reference, input) => { actual = input.action; return { status: 'cancelled' } } })
      expect(await f.run(message({ text }), signal)).toBe('consumed'); expect(actual).toBe(action)
    }
    const f = fixture({ inspectSecret: async () => ({ status: 'pending_choice', reference: 'synthetic-inspected-stage' }) })
    expect(await f.run(message({ text: '普通问题' }), signal)).toBe('enqueue')
  })
  it('没有事件ID不得提交秘密；捕获异常不泄露原异常/秘密或继续普通消息', async () => {
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }), applySecret: async () => { throw new Error('synthetic-secret') } })
    expect(await f.run(message({ text: 'synthetic-secret' }), signal)).toBe('consumed')
    expect(JSON.stringify(f.replies)).not.toContain('synthetic-secret')
    expect(await f.run(message({ scope: { ...message().scope, eventId: '' } }), signal)).toBe('consumed')
    expect(f.replies.at(-1)?.text).toContain('无法确认')
  })
  it('群聊不查私聊秘密stage；有待下载媒体不做文本交互和快捷取消', async () => {
    const f = fixture()
    expect(await f.run(message({ scope: { ...message().scope, chatType: 'group', chatId: 'group-a' }, hasPendingMedia: true }), signal)).toBe('enqueue')
    expect(f.calls).toEqual(['authorize'])
  })
  it('QQ秘密检查先于首次owner绑定及六位验证码，不从其他平台消费数字', async () => {
    let code = ''
    const f = fixture({ consumeBinding: async (_s, value) => { f.calls.push('binding'); code = value; return true } })
    expect(await f.run(message({ scope: { ...message().scope, platform: 'qq' }, text: 'BiNd 123456', hasPendingMedia: true }), signal)).toBe('consumed')
    expect(code).toBe('123456'); expect(f.calls).toEqual(['authorize', 'secret', 'qq-owner', 'binding'])
    const ordinary = fixture()
    expect(await ordinary.run(message({ text: '123456' }), signal)).toBe('enqueue')
    expect(ordinary.calls).not.toContain('binding')
  })
  it('Telegram只消费parser确认且定向当前Bot的bind，群命令不兑换码', async () => {
    let code = ''
    const f = fixture({ consumeBinding: async (_s, value) => { code = value; return false } })
    expect(await f.run(message({ text: '/bind@gugu_bot 123456', telegramCommand: 'bind' }), signal)).toBe('consumed')
    expect(code).toBe('123456'); expect(f.replies[0]?.text).toContain('绑定码无效')
    code = ''
    expect(await f.run(message({ scope: { ...message().scope, chatType: 'group', chatId: 'group-a' }, telegramCommand: 'bind' }), signal)).toBe('consumed')
    expect(code).toBe('')
  })
  it('等待输入/数字选项先于取消，保留正文并仅在可信mention时移除首个@', async () => {
    let semantic = ''
    const f = fixture({ consumeTextChoice: async (_s, text) => { semantic = text; return { status: 'awaiting_text' } } })
    const input = message({ text: '@咕咕 /stop', botMentioned: true })
    expect(await f.run(input, signal)).toBe('consumed')
    expect(semantic).toBe('/stop'); expect(input.text).toBe('@咕咕 /stop')
    expect(f.calls).not.toContain('shortcut'); expect(f.replies[0]?.text).toContain('直接发送')
    expect(imSemanticText('@别人 /stop', false)).toBe('@别人 /stop')
  })
  it('只对真正落地的取消回成功，无权取消不调用取消端口', async () => {
    const f = fixture({ decideShortcut: async () => ({ action: 'cancel', reply: '已取消', reference: 'synthetic-exact-run' }),
      cancel: async (_scope, reference) => { expect(reference).toBe('synthetic-exact-run'); return false } })
    expect(await f.run(message({ text: '/stop' }), signal)).toBe('consumed')
    expect(f.replies[0]?.text).toContain('尚未生效')
    const denied = fixture({ decideShortcut: async () => ({ action: 'no_permission', reply: '不是你的任务' }) })
    await denied.run(message(), signal); expect(denied.calls).not.toContain('cancel')
  })
  it('已提交交互的重放不重新回复或发起shortcut', async () => {
    const f = fixture({ consumeTextChoice: async () => ({ status: 'replay' }) })
    expect(await f.run(message(), signal)).toBe('consumed')
    expect(f.replies).toEqual([]); expect(f.calls).not.toContain('shortcut')
  })
  it('秘密capture竞态重放静默消费，业务失败不冒充保存成功', async () => {
    for (const status of ['replay', 'failed'] as const) {
      const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-inspected-stage' }), applySecret: async () => ({ status }) })
      expect(await f.run(message({ text: 'synthetic-secret' }), signal)).toBe('consumed')
      expect(f.replies.length).toBe(status === 'replay' ? 0 : 1)
      expect(JSON.stringify(f.replies)).not.toContain('已安全保存')
    }
  })
  it('状态或授权异常只暴露静态错误；取消保留原signal原因，不继续绑定', async () => {
    const f = fixture({ inspectSecret: async () => { throw new Error('synthetic-secret') } })
    await expect(f.run(message(), signal)).rejects.toEqual(new ImPreflightError())
    const controller = new AbortController(), reason = new Error('停止')
    controller.abort(reason)
    await expect(f.run(message(), controller.signal)).rejects.toBe(reason)
    expect(f.calls).toEqual(['authorize'])
  })
  it('secret apply必须收到inspect返回的同一引用和可信准入边界，缺引用不能转交值或普通排队', async () => {
    let reference = '', cutoff = ''
    const f = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'opaque-exact-observed-phase' }),
      applySecret: async (scope, token) => { reference = token; cutoff = scope.admissionCutoff!; return { status: 'completed' } } })
    const incoming = message({ scope: { ...message().scope, admissionCutoff: '2026-11-18T00:00:00.123456Z' }, text: 'synthetic-secret' })
    expect(await f.run(incoming, signal)).toBe('consumed')
    expect(reference).toBe('opaque-exact-observed-phase'); expect(cutoff).toBe(incoming.scope.admissionCutoff)
    let submitted = false
    const broken = fixture({ inspectSecret: async () => ({ status: 'awaiting_secret' } as never), applySecret: async () => { submitted = true; return { status: 'completed' } } })
    await expect(broken.run(incoming, signal)).rejects.toEqual(new ImPreflightError())
    expect(submitted).toBe(false)
  })
})
describe('统一交互文本匹配不改变声明序号及确认门', () => {
  const prompt = { kind: 'choice', secret: false, allowTextInput: false, customInputActive: false,
    options: [{ id: 'gone', label: '已消费', token: null }, { id: 'keep', label: 'Straße', token: 'opaque-token' }] }
  it('全角序号/Unicode casefold匹配原选项；已消费项不会让后项挤到第一位', () => {
    expect(selectImTextChoice(prompt, '１')).toBeNull()
    expect(selectImTextChoice(prompt, '２')).toEqual({ action: 'option', token: 'opaque-token' })
    expect(selectImTextChoice(prompt, 'STRASSE')).toEqual({ action: 'option', token: 'opaque-token' })
    expect(selectImTextChoice({ ...prompt, secret: true }, '２')).toBeNull()
  })
  it('真实选项存在时先选自定义回复；无真实选项可直接回复，不能跳过秘密入口', () => {
    expect(selectImTextChoice({ ...prompt, allowTextInput: true }, '任意回复')).toBeNull()
    expect(selectImTextChoice({ ...prompt, allowTextInput: true, customInputActive: true }, '任意回复')).toEqual({ action: 'text' })
    expect(selectImTextChoice({ ...prompt, allowTextInput: true, options: [{ id: '__custom_reply__', label: '自定义', token: 'opaque' }] }, '任意回复')).toEqual({ action: 'text' })
  })
})
