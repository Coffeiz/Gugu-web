import { desktopImEventKey } from '../src/main/im/gateway/inbound/inbox.js'
import { expect, it, vi } from 'vitest'
import { createDesktopImDispatch, stopDesktopImRun } from '../src/main/im/gateway/delivery/dispatch.js'
import { DesktopError } from '../src/main/core-host.js'
import { createRuntimeLog } from '@gugu/log/runtime'
import type { IpcHost } from '../src/main/ipc/types.js'

it.each([true, false])('本机投递先登记并防止发送状态恢复时重复回复（首次登记 %s）', async firstAttempt => {
  const controller = new AbortController()
  const connection = { platform: 'telegram', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'update', platformMessageId: '42', text: '测试', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c' as const, chatId: null, platformUserId: 'user' } }
  const actions: unknown[] = []
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 8, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') return { status: 'completed', cursor: 1, hasMore: false,
      events: [
        { type: 'display_event', item: { kind: 'assistant', eventId: '0', text: '阶段回复' } },
        { type: 'display_event', item: { kind: 'tool', eventId: 'tool', toolName: 'list_projects', toolStatus: 'success' } },
        { type: 'display_event', item: { kind: 'assistant', eventId: '1', text: '测试回复' } },
      ] }
    if (method !== 'im.inbox.delivery') throw new Error('请求无效')
    actions.push(params?.action)
    if (params?.action === 'begin') return firstAttempt
    controller.abort()
    return true
  })
  const send = vi.fn(async () => 'accepted' as const)
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() }, async () => ({ theme: 'system', themeFamily: 'mono', palette: 'neutral', showIntermediateReplies: false, imToolDisplayMode: 'off' }))
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, send })
  expect(actions).toEqual(['begin', firstAttempt ? 'accepted' : 'unknown'])
  if (firstAttempt) expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipient: 'user', originalMessageId: '42', text: '测试回复' }), undefined)
  else expect(send).not.toHaveBeenCalled()
})

it('微信回复凭据随事件加密，数据库索引只使用摘要', async () => {
  const { createDesktopImInbox } = await import('../src/main/im/gateway/inbound/inbox.js')
  const request = vi.fn(async (_method: string, _params: unknown) => true)
  const encryptStringAsync = vi.fn(async (_value: string) => Buffer.from([1]))
  const admit = createDesktopImInbox({ request: request as IpcHost['request'] }, {
    encryptStringAsync, async isAsyncEncryptionAvailable() { return true },
  })
  const event = { version: 1, kind: 'message.received', eventId: 'synthetic-context', text: '测试', quotedText: null, botMentioned: false,
    scope: { platform: 'wechat', botId: 'bot', ownerId: 'desktop', chatType: 'c2c' as const, chatId: null, platformUserId: 'user' },
  } as const
  await admit(event.scope, 'connection', event, 'synthetic-context')
  const otherSender = { ...event, scope: { ...event.scope, platformUserId: 'other-user' } }
  await admit(event.scope, 'connection', otherSender, 'other-context')
  expect(request.mock.calls[0]?.[1]).not.toMatchObject({ eventKey: desktopImEventKey(otherSender) })
  expect(JSON.parse(encryptStringAsync.mock.calls[0]![0])).toEqual({ event, replyContext: 'synthetic-context' })
  await expect(admit({ ...event.scope, botId: 'other-bot' }, 'connection', event)).rejects.toThrow('连接范围不匹配')
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledWith('im.inbox.admit', {
    platform: 'wechat', connectionId: 'connection', eventKey: expect.stringMatching(/^[a-f0-9]{64}$/), sealedEvent: 'AQ==',
  })
})

it('等待运行恢复时从上次游标续读并保留先前的回复正文', async () => {
  const controller = new AbortController()
  const connection = { platform: 'telegram', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'event', text: '测试', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c' as const, chatId: null, platformUserId: 'user' } }
  const offsets: unknown[] = []
  const request = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event),
      sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') {
      offsets.push(params?.after)
      return offsets.length === 1
        ? { cursor: 7, hasMore: false, status: 'waiting',
          events: [{ type: 'display_event', item: { kind: 'assistant', eventId: 'first', text: '第一段' } }] }
        : { cursor: 8, hasMore: false, status: 'completed', events: [] }
    }
    if (params?.action === 'accepted') controller.abort()
    return true
  }
  const send = vi.fn(async () => 'accepted' as const)
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, send })
  expect(offsets).toEqual([0, 7])
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: '第一段' }), undefined)
})

it.each([
  { first: true, kind: 'confirm', paused: true },
  { first: false, kind: 'confirm', paused: true },
  { first: true, kind: 'choice', paused: false },
  { first: false, kind: 'choice', paused: false },
])('QQ $kind 卡片先登记，重复登记时不发送（首次 $first）', async ({ first, kind, paused }) => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'event', text: '测试', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c' as const, chatId: null, platformUserId: 'user' } }
  const eventKey = desktopImEventKey(event)
  const choice = { id: 'yes', label: '继续', token: 'synthetic' }
  const prompt = { type: 'interaction_required', kind, task_paused: paused, prompt_id: 3, title: '合成提示',
    secret_fields: [], options: paused ? [choice] : [choice, { id: '__custom_reply__', label: '自定义回复', token: 'custom' }] }
  const operations: unknown[] = []
  const request = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: 'run', eventKey, sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') return { status: 'waiting', cursor: 1, hasMore: false, events: [prompt] }
    operations.push(params?.action)
    if (params?.action === 'begin' && first) return true
    if (params?.action === 'settle') expect(params).toMatchObject({ messageId: 'platform-card', promptId: 3, runId: 'run' })
    controller.abort()
    return false
  }
  const sendPrompt = vi.fn(async () => { operations.push('send'); return 'platform-card' })
  const send = vi.fn(async () => 'accepted' as const)
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, send, sendPrompt })
  expect(operations).toEqual(first ? ['begin', 'send', 'settle'] : ['begin'])
  if (first) expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ options: prompt.options }), 'user')
  expect(send).not.toHaveBeenCalled()
})

it('投递已登记后绑定被撤销时结案且不发送平台回复', async () => {
  const controller = new AbortController()
  const connection = { platform: 'telegram', botId: 'bot', ownerId: 'desktop' } as const
  const event = {
    version: 1, kind: 'message.received', eventId: 'update', platformMessageId: 'reference-index', text: '合成收件',
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' },
    quotedText: null, botMentioned: false,
  } as const
  let allowed = true
  const actions: unknown[] = []
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return {
      sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client',
    }
    if (method === 'agent.sessions.events') return {
      status: 'completed', cursor: 1, hasMore: false,
      events: [{ type: 'display_event', item: { kind: 'assistant', eventId: '1', text: '合成回复' } }],
    }
    if (method !== 'im.inbox.delivery') throw new Error('请求无效')
    actions.push(params?.action)
    if (params?.action === 'begin') allowed = false
    else controller.abort()
    return true
  })
  const send = vi.fn(async () => 'accepted' as const)
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => allowed, send })
  expect(actions).toEqual(['begin', 'rejected'])
  expect(send).not.toHaveBeenCalled()
})

it('运行期间发送已结束的中间轮和慢工具，最终正文单独投递', async () => {
  const controller = new AbortController()
  const connection = { platform: 'telegram', botId: 'bot', ownerId: 'desktop' } as const
  const event = {
    version: 1, kind: 'message.received', eventId: 'update', platformMessageId: 'reference-index', text: '合成收件',
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' },
    quotedText: null, botMentioned: false,
  } as const
  const sent: string[] = []
  const notices = new Set<unknown>()
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return {
      sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client',
    }
    if (method === 'agent.sessions.events') {
      expect(params?.imDelivery).toBe(true)
      if (params?.after === 0) return { status: 'running', cursor: 1, hasMore: true, events: [
        { type: 'im_round_end', sequence: 1, text: '阶段回复' },
      ] }
      if (params?.after === 1) {
        expect(sent).toEqual(['阶段回复'])
        return { status: 'running', cursor: 3, hasMore: true, events: [
        { type: 'display_event', item: { kind: 'tool', eventId: 'slow', toolName: 'list_projects', toolLabelOverride: '查询项目列表', toolStatus: 'success', toolDurationMs: 6000 } },
        ] }
      }
      expect(sent).toEqual(['阶段回复', '✅ 查询项目列表完成'])
      return { status: 'completed', cursor: 5, hasMore: false, events: [
        { type: 'display_event', item: { kind: 'tool', eventId: 'slow', toolName: 'list_projects', toolLabelOverride: '查询项目列表', toolStatus: 'success', toolDurationMs: 6000 } },
        { type: 'display_event', item: { kind: 'tool', eventId: 'fast', toolName: 'get_project', toolStatus: 'success', toolDurationMs: 100 } },
        { type: 'im_round_end', sequence: 4, text: '最终正文' },
        { type: 'im_final_text', text: '最终正文' },
      ] }
    }
    if (method !== 'im.inbox.delivery') throw new Error('请求无效')
    if (params?.action === 'begin' && params.noticeKey) {
      if (notices.has(params.noticeKey)) return false
      notices.add(params.noticeKey)
    }
    if (params?.action === 'accepted' && !params.noticeKey) controller.abort()
    return true
  })
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() }, async () => ({
    theme: 'system', themeFamily: 'mono', palette: 'neutral', showIntermediateReplies: true, imToolDisplayMode: 'slow_only',
  }))
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, async send(reply) { sent.push(reply.text); return 'accepted' } })
  expect(sent).toEqual(['阶段回复', '✅ 查询项目列表完成', '最终正文'])
})

it('微信仅在运行中显示输入状态，并在回复前结束', async () => {
  const controller = new AbortController()
  const connection = { platform: 'wechat', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'message:1', text: '测试', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' } }
  const calls: string[] = []
  let active = true
  const request = (async (method: string) => {
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') {
      const status = active ? 'running' : 'completed'
      active = false
      return { status, cursor: 1, hasMore: false, events: status === 'completed' ?
        [{ type: 'display_event', item: { kind: 'assistant', eventId: 'reply', text: '测试回复' } }] : [] }
    }
    return true
  }) as IpcHost['request']
  const dispatch = createDesktopImDispatch({ request }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event, replyContext: 'synthetic' }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal, authorize: async () => true,
    startTyping(context) {
      expect(context).toBe('synthetic')
      calls.push('开始输入')
      return async () => { calls.push('停止输入') }
    },
    async send() {
      calls.push('回复')
      controller.abort()
      return 'accepted'
    },
  })
  expect(calls).toEqual(['开始输入', '停止输入', '回复'])
})

it.each(['accepted', 'unknown'] as const)('QQ 流式结果为 %s 时不走普通正文投递', async (outcome) => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'update', platformMessageId: 'reference-index', text: '合成收件', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' } } as const
  const runEvent = { id: 'final', identity: { ownerId: 'owner', sessionId: '1', runId: 'run' }, sequence: 1, round: 1,
    type: 'final', payload: { text: '最终正文', status: 'completed' } }
  const actions: unknown[] = []
  const request = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') {
      expect(params?.imStream).toBe(true)
      return { status: 'completed', cursor: 1, hasMore: false, events: [
        { type: 'im_stream', runEvent }, { type: 'im_final_text', text: '最终正文' },
      ] }
    }
    if (method !== 'im.inbox.delivery') throw new Error('请求无效')
    actions.push(params?.action)
    if (params?.action !== 'begin') controller.abort()
    return true
  }) as IpcHost['request']
  const dispatch = createDesktopImDispatch({ request }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  const project = vi.fn(async () => outcome)
  const send = vi.fn(async () => 'accepted' as const)
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, send,
    async createStream(target) {
      expect(target).toMatchObject({ messageId: 'update', referenceMessageId: 'reference-index' })
      return { project, async close() {} }
    },
  })
  expect(project).toHaveBeenCalledExactlyOnceWith(runEvent)
  expect(send).not.toHaveBeenCalled()
  expect(actions).toEqual(['begin', outcome])
})

it('桌面 QQ 运行通知立即唤醒当前投递，结束时解除订阅', async () => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'update', text: '合成收件', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' } } as const
  const unsubscribe = vi.fn()
  const reread = vi.fn()
  let notify: ((sessionId: number, runId: string) => void) | undefined
  const request = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method !== 'agent.sessions.events') throw new Error('请求无效')
    if (params?.after === 0) {
      // 模拟通知早于当前读取返回，游标仍只前进到已读事件。
      notify?.(1, 'run')
      return { status: 'running', cursor: 1, hasMore: false, events: [] }
    }
    reread(params?.after)
    controller.abort()
    return { status: 'running', cursor: 2, hasMore: false, events: [] }
  }) as IpcHost['request']
  const dispatch = createDesktopImDispatch({ request, onAgentRunChanged(listener) { notify = listener; return unsubscribe } }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  const task = dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, async send() { return 'accepted' } })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reread).toHaveBeenCalledExactlyOnceWith(1)
  } finally {
    controller.abort()
    await task
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('桌面 QQ 重复附件收件只清理本次文件，并将原附件交给 Agent', async () => {
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createDesktopImInbox } = await import('../src/main/im/gateway/inbound/inbox.js')
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-media-'))
  const controller = new AbortController()
  const connection = { platform: 'qq', ownerId: 'desktop', botId: 'bot' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'image', text: '', quotedText: null, botMentioned: false,
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' } } as const
  let sealedEvent: string | undefined
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.admit') {
      if (sealedEvent) return false
      sealedEvent = params?.sealedEvent as string
      return true
    }
    if (method === 'im.inbox.prepare') return { sessionId: 1, runId: null, eventKey: desktopImEventKey(event), sealedEvent, clientId: 'client' }
    if (method === 'agent.sessions.startRun') { controller.abort(); return null }
    throw new Error('请求无效')
  })
  const host = { request: request as IpcHost['request'] }
  try {
    const inbox = createDesktopImInbox(host, {
      async isAsyncEncryptionAvailable() { return true },
      async encryptStringAsync(value) { return Buffer.from(value) },
    }, directory)
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const media = { files: [{ name: '测试', ext: 'png', mime: 'image/png', voice: false, bytes }], async authorize() { return true } }
    const connectionId = 'a'.repeat(64)
    await inbox(connection, connectionId, event, undefined, media)
    await inbox(connection, connectionId, event, undefined, media)
    const { attachments } = JSON.parse(Buffer.from(sealedEvent!, 'base64').toString())
    expect(await readdir(join(directory, 'agent-attachments'))).toEqual(attachments)
    expect(await readFile(join(directory, 'agent-attachments', attachments[0]))).toEqual(bytes)
    const dispatch = createDesktopImDispatch(host, {
      async decryptStringAsync(value) { return { result: value.toString(), shouldReEncrypt: false } },
    }, { resolveRunModelSelection: vi.fn(async () => ({ config: {} as never, id: 'synthetic' })) })
    await dispatch({ connection, connectionId, userId: 'user', signal: controller.signal,
      async authorize() { return true }, async send() { return 'accepted' } })
    expect(request).toHaveBeenCalledWith('agent.sessions.startRun', expect.objectContaining({ text: '', attachments }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('桌面群调度只向已授权的原群发送最终正文', async () => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'update', platformMessageId: 'message', text: '测试群消息',
    quotedText: null, botMentioned: true, scope: { ...connection, chatType: 'group', chatId: 'group', platformUserId: 'member' } } as const
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') {
      expect(params).toMatchObject({ chatType: 'group', ownerPlatformUserId: 'synthetic-owner' })
      return { sessionId: 1, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    }
    if (method === 'agent.sessions.events') return { status: 'completed', cursor: 1, hasMore: false, events: [
      { type: 'im_round_end', sequence: 1, text: '中间正文' }, { type: 'round_start' }, { type: 'im_final_text', text: '最终正文' },
    ] }
    if (method === 'im.inbox.delivery') {
      if (params?.action === 'accepted') controller.abort()
      return true
    }
    throw new Error('请求无效')
  })
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() })
  const authorizeMessage = vi.fn(async () => true)
  const send = vi.fn(async () => 'accepted' as const)
  await dispatch({ connection, connectionId: 'a'.repeat(64), signal: controller.signal,
    group: { id: 'group', ownerPlatformUserId: 'synthetic-owner', authorizeMessage, async authorizeFile() { return false } }, async authorize() { return true }, send })
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    recipient: 'group', originalMessageId: event.eventId, text: '最终正文',
  }), undefined)
  expect(authorizeMessage).toHaveBeenCalledOnce()
})

it.each(['storage_error', 'busy'])('重复 RPC 故障 %s 退避，只记录一次安全诊断，恢复后继续补读', async (errorCode) => {
  const controller = new AbortController()
  const regular = vi.fn()
  const diagnostic = vi.fn()
  const log = createRuntimeLog({ regular, diagnostic })
  const failure = new DesktopError(errorCode, '合成内部详情')
  const timestamps: number[] = []
  const request = vi.fn(async () => {
    timestamps.push(performance.now())
    if (timestamps.length < 3) throw failure
    controller.abort()
    return null
  })
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    decryptStringAsync: vi.fn(),
  }, { resolveRunModelSelection: vi.fn() }, undefined,
  (code, error, rpcMethod) => log('gateway.degraded', { code, error, rpcMethod }))
  const send = vi.fn()
  await dispatch({
    connection: { platform: 'telegram', botId: 'bot', ownerId: 'desktop' },
    connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => true, send,
  })
  expect(request).toHaveBeenCalledTimes(3)
  expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(950)
  expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(1950)
  expect(send).not.toHaveBeenCalled()
  if (errorCode === 'busy') {
    expect(regular).not.toHaveBeenCalled()
    expect(diagnostic).not.toHaveBeenCalled()
  } else {
    expect(regular).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledOnce()
    expect(JSON.parse(regular.mock.calls[0]![0])).toMatchObject({
      attributes: { code: 'dispatch_unavailable', errorCode, rpcMethod: 'im.inbox.prepare' },
    })
    expect(diagnostic.mock.calls[0]![0]).not.toContain('合成内部详情')
  }
}, 10_000)

it.each(['slow_only', 'off'] as const)('QQ 整理按展示偏好发送主动回执并保留最终被动回复（%s）', async imToolDisplayMode => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'trigger', platformMessageId: 'ref', text: '测试',
    quotedText: null, botMentioned: false, scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'user' } }
  const notices = vi.fn(async () => 'accepted' as const)
  const send = vi.fn(async () => 'accepted' as const)
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prepare') return { sessionId: 8, runId: 'run', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'agent.sessions.events') return { status: 'completed', cursor: 4, hasMore: false, events: [
      { type: 'im_compaction', sequence: 1, phase: 'started' },
      { type: 'im_compaction', sequence: 2, phase: 'completed', applied: false },
      { type: 'im_compaction', sequence: 3, phase: 'completed', applied: true },
      { type: 'im_final_text', text: '最终回复' },
    ] }
    if (method !== 'im.inbox.delivery') throw new Error('请求无效')
    if (params?.action === 'accepted' && !params.noticeKey) controller.abort()
    return true
  })
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection: vi.fn() }, async () => ({
    theme: 'system', themeFamily: 'mono', palette: 'neutral', showIntermediateReplies: false, imToolDisplayMode,
  }))
  await dispatch({ connection, connectionId: 'a'.repeat(64), userId: 'user', signal: controller.signal,
    authorize: async () => !controller.signal.aborted, send, sendActiveNotice: notices })
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ originalMessageId: 'trigger', text: '最终回复' }), undefined)
  expect(notices.mock.calls).toEqual(imToolDisplayMode === 'off' ? [] : [
    [expect.objectContaining({ originalMessageId: undefined, text: '上下文较长，正在整理后继续处理。' })],
    [expect.objectContaining({ originalMessageId: undefined, text: '本次未能整理上下文，继续处理。' })],
    [expect.objectContaining({ originalMessageId: undefined, text: '上下文整理完成。' })],
  ])
})

it.each([
  { text: '@咕咕 /shell', methods: [], reply: '/shell 范围切换已退役' },
  { text: '@咕咕 /help shell', methods: [], reply: '/shell 范围切换已退役' },
  { text: '@咕咕 /help', group: 'member', methods: [], reply: '当前入口可用命令' },
  { text: '/help', methods: [], reply: '当前入口可用命令' },
  { text: '@咕咕 /workspace', methods: ['agent.sessions.workspace'], reply: '当前会话绑定的工作区' },
  { text: '@咕咕 /workspace personal', methods: ['agent.sessions.setWorkspace'], reply: '已将当前会话切回个人文件' },
  { text: '@咕咕 /workspace unbind', methods: ['agent.sessions.setWorkspace'], reply: '已将当前会话切回个人文件' },
  { text: '@咕咕 助手 /workspace list', methods: ['agent.sessions.workspace'], reply: '1. 合成目录' },
  { text: '@咕咕 /workspace god', methods: [], reply: '桌面端当前不提供完整用户沙箱授权' },
  { text: '@咕咕 /workspace delete 1', methods: [], reply: '确认请发送 /workspace delete 1 confirm' },
  { text: '@咕咕 /workspace delete 1 confirm', methods: [], reply: '已删除工作区' },
  { text: '@咕咕 /workspace delete 1 confirm', group: 'owner', methods: [], reply: '请在私聊中' },
  { text: '@咕咕 /status', group: 'member', methods: ['im.inbox.status'], status: 'waiting', reply: '正在等待你的确认' },
  { text: '@咕咕 /status', group: 'member', methods: ['im.inbox.status'], status: 'waiting_agent', reply: '正在等待子 Agent 的消息' },
  { text: '@咕咕 /goal status', methods: ['agent.sessions.goal'], reply: '当前目标任务' },
  { text: '@咕咕 /goal 小北的测试目标', group: 'member', methods: [], reply: '只有绑定 Bot 的用户' },
  { text: '@咕咕 /new', methods: ['agent.sessions.resetImContext'], reply: '旧的对话上下文已清空' },
  { text: '@咕咕 /new', group: 'member', methods: [], reply: '只有绑定 Bot 的用户' },
  { text: '@咕咕 /mem', group: 'owner', methods: ['agent.memory.read'], reply: '已私聊发送个人记忆' },
  { text: '@咕咕 /mem', group: 'member', methods: [], reply: '只有绑定 Bot 的用户' },
  { text: '@咕咕 /mem', methods: ['agent.memory.read'], reply: '合成长期记忆' },
  { text: '@咕咕 /forget 小北', methods: ['agent.memory.forget', 'agent.memory.forget'], reply: '已忘掉匹配的 2 条记忆' },
  { text: '@咕咕 /forget 小北', group: 'member', methods: [], reply: '只有绑定 Bot 的用户' },
  { text: '@咕咕 /compact', methods: ['agent.sessions.compact', 'agent.sessions.events'], reply: '上下文已整理' },
  { text: '@咕咕 /compact', group: 'owner', methods: ['agent.sessions.compact', 'agent.sessions.events'], reply: '上下文已整理' },
  { text: '@咕咕 /compact', group: 'member', methods: [], reply: '只有绑定 Bot 的用户' },
])('IM 命令 $text 只进入对应处理器', async ({ text, methods, reply, group, status }) => {
  const controller = new AbortController()
  const connection = { platform: 'qq', botId: 'bot', ownerId: 'desktop' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'trigger', platformMessageId: 'ref', text,
    quotedText: null, botMentioned: text.startsWith('@'), scope: { ...connection, chatType: group ? 'group' : 'c2c', chatId: group ? 'group' : null, platformUserId: group ?? 'user' } }
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'im.inbox.prepare') return { sessionId: 8, runId: null, eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', clientId: 'client' }
    if (method === 'im.inbox.reject') return true
    if (method === 'agent.sessions.setWorkspace') {
      expect(params).toMatchObject({ action: 'unlink' })
      return { workspace: null }
    }
    if (method === 'agent.sessions.workspace' && text.endsWith('/workspace')) {
      expect(params).toMatchObject({ action: 'show' })
      return { workspace: { workspace_name: '合成目录' } }
    }
    if (method === 'agent.sessions.workspace') return { workspaces: [{ id: 'desktop:11111111-1111-4111-8111-111111111111', name: '合成目录', commandNumber: 1 }] }
    if (method === 'agent.memory.read') return { text: '合成长期记忆' }
    if (method === 'im.inbox.status') {
      expect(params).toMatchObject({ chatType: 'group', platformUserId: 'member', ownerPlatformUserId: 'owner' })
      return { status }
    }
    if (method === 'agent.sessions.goal') return { text: '当前目标任务：合成目标' }
    if (method === 'agent.sessions.resetImContext') return { reset: true }
    if (method === 'agent.memory.forget') {
      expect(params).toMatchObject({ query: '小北' })
      return { count: 2, revision: 'a'.repeat(64) }
    }
    if (method === 'agent.sessions.compact') {
      if (group) expect(params).toMatchObject({ imGroupSenderId: 'owner' })
      return { operation: 'compact-1' }
    }
    if (method === 'agent.sessions.events') return { status: 'completed', events: [{ type: 'content', text: '上下文已整理' }] }
    throw new Error('斜杠命令不应创建运行')
  })
  const resolveRunModelSelection = vi.fn().mockResolvedValue({ config: {} })
  const send = vi.fn(async () => { controller.abort(); return 'accepted' as const })
  const remove = vi.fn(async () => undefined)
  const dispatch = createDesktopImDispatch({ request: request as IpcHost['request'] }, {
    async decryptStringAsync() { return { result: JSON.stringify({ event }), shouldReEncrypt: false } },
  }, { resolveRunModelSelection }, undefined, undefined, undefined, {
    async list() { return [{ id: 'desktop:synthetic', name: '合成目录', commandNumber: 1 }] }, remove,
  })
  const sendOwnerPrivate = vi.fn(async () => 'accepted' as const)
  await dispatch({ connection, sendOwnerPrivate, connectionId: 'a'.repeat(64), signal: controller.signal,
    ...(group ? { group: { id: 'group', ownerPlatformUserId: 'owner',
      async authorizeMessage() { return true }, async authorizeFile() { return false } } } : { userId: 'user' }),
    authorize: async () => !controller.signal.aborted, send })
  expect(request.mock.calls.map(([method]) => method)).toEqual(['im.inbox.prepare', 'im.inbox.reject', ...methods])
  expect(sendOwnerPrivate.mock.calls).toEqual(group === 'owner' && text.endsWith('/mem') ? [['合成长期记忆']] : [])
  expect(remove).toHaveBeenCalledTimes(!group && text.endsWith('delete 1 confirm') ? 1 : 0)
  expect(resolveRunModelSelection).toHaveBeenCalledTimes(methods.includes('agent.sessions.compact') ? 1 : 0)
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    originalMessageId: 'trigger', text: expect.stringContaining(reply),
  }), undefined)
})

it('即时停止命令重投复用原操作标识，保留群发起者范围', async () => {
  const request = vi.fn(async (_method: string, _params: unknown, _operation?: string) => ({ outcome: 'requested' }))
  const scope = { platform: 'feishu', ownerId: 'desktop', botId: 'synthetic-bot',
    chatType: 'group', chatId: 'synthetic-room', platformUserId: 'synthetic-sender' } as const
  const event = { version: 1, kind: 'message.received', eventId: 'synthetic-first', scope, text: '@咕咕 /stop',
    quotedText: null, botMentioned: true } as const
  const host = { request: request as IpcHost['request'] }
  await stopDesktopImRun(host, event, 'a'.repeat(64), 'synthetic-owner')
  await stopDesktopImRun(host, event, 'a'.repeat(64), 'synthetic-owner')
  await stopDesktopImRun(host, { ...event, eventId: 'synthetic-second' }, 'a'.repeat(64), 'synthetic-owner')
  expect(request.mock.calls[0]?.[1]).toMatchObject({ platformUserId: 'synthetic-sender', ownerPlatformUserId: 'synthetic-owner' })
  expect(request.mock.calls[0]?.[2]).toBe(request.mock.calls[1]?.[2])
  expect(request.mock.calls[0]?.[2]).not.toBe(request.mock.calls[2]?.[2])
})

it('监听模式空闲时不补读，仅由对应连接的收件事件唤醒', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const connectionId = 'a'.repeat(64)
  let onInbox: ((platform: string, id: string) => void) | undefined
  const unsubscribe = vi.fn()
  const request = vi.fn(async () => null)
  const dispatch = createDesktopImDispatch({
    request: request as IpcHost['request'],
    onAgentRunChanged: () => unsubscribe,
    onImInboxChanged(listener) { onInbox = listener; return unsubscribe },
  }, { decryptStringAsync: vi.fn() }, { resolveRunModelSelection: vi.fn() })
  const work = dispatch({
    connection: { platform: 'telegram', botId: 'bot', ownerId: 'desktop' },
    connectionId, userId: 'user', signal: controller.signal,
    authorize: async () => true, send: vi.fn(),
  })
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(1)
    onInbox?.('telegram', 'b'.repeat(64))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request).toHaveBeenCalledTimes(1)
    onInbox?.('telegram', connectionId)
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort()
    await work
    vi.useRealTimers()
  }
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})
