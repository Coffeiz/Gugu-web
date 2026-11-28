import { feishuPrivateReply } from '../../../packages/gateway/tests/fixtures/private-replies.js'
import type { createDesktopImDispatch } from '../src/main/im/gateway/delivery/dispatch.js'
import { feishuPrivateInteraction } from '../../../packages/gateway/tests/fixtures/feishu-private-interaction.js'
import { feishuPrivateMessage, feishuPrivateText } from '../../../packages/gateway/tests/fixtures/feishu-private-message.js'
import { expect, it, vi } from 'vitest'
import { createDesktopImCallback } from '../src/main/im/gateway/interactions/callback.js'
import type { IpcHost } from '../src/main/ipc/types.js'
import type { FeishuConnectionOptions } from '@gugu/gateway/feishu'
import { createDesktopFeishuGateway } from '../src/main/im/gateway/platforms/feishu/index.js'

it('飞书桌面只登记绑定用户私聊，撤权后拒绝入站', async () => {
  const appId = 'cli_0123456789abcdef'
  const bot = { appId, appSecret: 'synthetic-secret', userId: feishuPrivateMessage.sender.sender_id.open_id, enabled: true, revision: '1' }
  const admit = vi.fn(async () => {})
  let awaitingText = false
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'im.inbox.prompt') return params?.promptId === 7 && params.messageId === 'om_card'
      ? { sessionId: 8, runId: 'run' } : null
    if (method === 'agent.sessions.runModel') return null
    if (method === 'agent.sessions.respond') return { awaitingText }
    return {}
  })
  const callback = vi.fn(createDesktopImCallback({ request: request as IpcHost['request'] }, {
    resolveRunModel: vi.fn(),
  }))
  const connected = Promise.withResolvers<FeishuConnectionOptions>()
  const dispatch = Promise.withResolvers<Parameters<ReturnType<typeof createDesktopImDispatch>>[0]>()
  const transcribe = vi.fn(async () => "  飞书语音测试  ")
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const outbound: Array<Record<string, unknown>> = []
  const reactions: string[] = []
  const gateway = createDesktopFeishuGateway({ read: async () => bot }, admit, async options => { dispatch.resolve(options) },
    () => ({ async request(request) {
      if (request.url.includes('/resources/')) {
        if (request.url.includes('img_missing')) return { status: 404, headers: {}, body: (async function* () {})(), cancel() {} }
        return { status: 200, headers: {}, body: (async function* () { yield jpeg })(), cancel() {} }
      }
      const parent = /\/messages\/(om_parent|om_other)$/.exec(new URL(request.url).pathname)?.[1]
      if (parent) {
        const response = { code: 0, data: { items: [{
          chat_id: parent === 'om_parent' ? feishuPrivateMessage.message.chat_id : 'oc_other',
          message_id: parent, msg_type: 'text', body: { content: '{"text":"引用内容"}' },
        }] } }
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(response)) })(), cancel() {} }
      }
      const path = new URL(request.url).pathname
      if (path.endsWith('/reactions')) {
        reactions.push(path)
        return { status: 200, headers: {}, body: (async function* () {
          yield Buffer.from(JSON.stringify({ code: 0, data: { reaction_id: 'synthetic-reaction' } }))
        })(), cancel() {} }
      }
      const sending = path.endsWith('/im/v1/messages')
      if (sending) outbound.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()))
      const response = sending ? { code: 0, data: { message_id: 'om_reply' } } : request.url.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
        : { code: 0, bot: { open_id: 'ou_bot' } }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(response)) })(), cancel() {} }
    } }),
    async options => {
      connected.resolve(options)
      const closed = Promise.withResolvers<void>()
      return { closed: closed.promise, async stop() { await options.wsNetwork.close(); closed.resolve() } }
    }, callback, { transcribe, report: vi.fn() })
  try {
    await gateway.start()
    const connection = await connected.promise
    const signal = new AbortController().signal
    const message = (user: string, chatType: string) => ({
      app_id: appId, sender: { sender_id: { open_id: user }, sender_type: 'user' },
      message: { chat_type: chatType, chat_id: 'oc_chat', message_id: 'om_message', message_type: 'text', content: '{"text":"测试"}' },
    })
    await connection.onMessage(message('ou_other', 'p2p'), signal)
    await connection.onMessage(message(bot.userId, 'group'), signal)
    await connection.onMessage({ ...feishuPrivateMessage, app_id: appId, message: { ...feishuPrivateMessage.message, parent_id: 'om_parent' } }, signal)
    await vi.waitFor(() => expect(reactions).toEqual([
      `/open-apis/im/v1/messages/${feishuPrivateMessage.message.message_id}/reactions`,
    ]))
    const action = feishuPrivateInteraction
    expect(await connection.onCardAction(action, signal)).toMatchObject({
      toast: { type: 'info' },
      card: { type: 'raw', data: { elements: [
        { tag: 'div', text: { tag: 'plain_text', content: '已确认收到选择，咕咕将继续处理。' } },
      ] } },
    })
    expect(callback).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('agent.sessions.respond', expect.objectContaining({
      id: 8, runId: 'run', promptId: 7, token: 'synthetic-action',
    }))
    awaitingText = true
    const customAction = { ...action, header: { ...action.header, event_id: 'custom-reply-event' } }
    const customResponse = await connection.onCardAction(customAction, signal)
    const hint = '请在当前飞书聊天中发送你的回答，咕咕收到后会继续处理。'
    expect(customResponse).toMatchObject({
      toast: { type: 'info', content: hint },
      card: { type: 'raw', data: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: hint } }] } },
    })
    const delivery = await dispatch.promise
    const reply = { version: 1, kind: 'reply.requested', ...feishuPrivateReply,
      scope: { ...delivery.connection, chatType: 'c2c', chatId: null, platformUserId: feishuPrivateReply.recipient } } as const
    expect(await delivery.send(reply)).toBe('accepted')
    expect(outbound).toEqual([expect.objectContaining({ receive_id: feishuPrivateReply.recipient, msg_type: 'interactive' })])
    expect(outbound[0]?.content).toContain(feishuPrivateReply.text)
    await delivery.sendPrompt!({ prompt_id: 7, title: '选择一个方案', options: [
      { id: 'a', label: '方案 A', token: 'synthetic-a' },
      { id: 'b', label: '方案 B', token: 'synthetic-b' },
      { id: '__custom_reply__', label: '自定义回复', token: 'synthetic-custom' },
    ] }, bot.userId)
    const card = JSON.parse(String(outbound[1]?.content))
    const choices = card.elements.find((element: { tag: string }) => element.tag === 'action')
    expect(choices.actions.map((button: { value: { option_id: string } }) => button.value.option_id))
      .toEqual(['a', 'b', '__custom_reply__'])
    const imageMessage = {
      ...feishuPrivateMessage, app_id: appId,
      message: { ...feishuPrivateMessage.message, message_id: 'om_image', parent_id: 'om_other', message_type: 'image', content: '{"image_key":"img_test"}' },
    }
    await connection.onMessage(imageMessage, signal)
    expect(admit).toHaveBeenNthCalledWith(2, expect.objectContaining({ platform: 'feishu', ownerId: 'desktop' }), expect.any(String), expect.objectContaining({ eventId: 'om_image', text: '', quotedText: null }),
      imageMessage.message.chat_id, expect.objectContaining({ files: [expect.objectContaining({ mime: 'image/jpeg', bytes: jpeg })] }))
    const voiceMessage = {
      ...imageMessage,
      message: { ...imageMessage.message, message_id: 'om_voice', message_type: 'audio', content: '{"file_key":"file_voice"}' },
    }
    await connection.onMessage(voiceMessage, signal)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      bytes: expect.any(Uint8Array), mime: 'application/octet-stream', ext: 'opus',
    }), expect.any(AbortSignal), expect.any(Function))
    expect(admit).toHaveBeenNthCalledWith(3, expect.objectContaining({ platform: 'feishu', ownerId: 'desktop' }), expect.any(String), expect.objectContaining({ eventId: 'om_voice' }),
      imageMessage.message.chat_id, expect.objectContaining({ files: [expect.objectContaining({ voice: true, transcript: '飞书语音测试' })] }))
    await connection.onMessage({
      ...imageMessage,
      message: { ...imageMessage.message, message_id: 'om_missing', content: '{"image_key":"img_missing"}' },
    }, signal)
    expect(outbound.at(-1)).toMatchObject({ receive_id: bot.userId, msg_type: 'interactive' })
    expect(outbound.at(-1)?.content).toContain('暂时无法从飞书下载附件')
    const sentBeforeRevocation = outbound.length
    bot.enabled = false
    expect(await delivery.send(reply)).toBe('rejected')
    expect(outbound).toHaveLength(sentBeforeRevocation)
    const rejectedAction = await connection.onCardAction(action, signal)
    expect(rejectedAction).toMatchObject({ toast: { type: 'error' } })
    expect(rejectedAction).not.toHaveProperty('card')
    expect(callback).toHaveBeenCalledTimes(2)
    await connection.onMessage({ ...feishuPrivateMessage, app_id: appId, message: { ...feishuPrivateMessage.message, parent_id: 'om_parent' } }, signal)
    await connection.onMessage(imageMessage, signal)
    await connection.onMessage(voiceMessage, signal)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(admit).toHaveBeenCalledTimes(3)
    expect(admit).toHaveBeenNthCalledWith(1, expect.objectContaining({ platform: 'feishu', ownerId: 'desktop' }), expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({
      eventId: feishuPrivateMessage.message.message_id, text: feishuPrivateText, quotedText: '引用内容',
      scope: expect.objectContaining({ platform: 'feishu', chatType: 'c2c', platformUserId: bot.userId }),
    }), feishuPrivateMessage.message.chat_id, expect.objectContaining({ files: [], authorize: expect.any(Function) }))
  } finally { await gateway.stop() }
})

it('飞书桌面按共享群策略登记群收件并启动群会话分发', async () => {
  const appId = 'cli_0123456789abcdef'
  const ownerId = 'ou_owner'
  const bot = { appId, appSecret: 'synthetic-secret', userId: ownerId, enabled: true, revision: '1',
    groupChatEnabled: true, groupReplyMode: 'reply_mentions' as const, groupAttentionMode: 'autonomous' as const,
    groupAllowedTools: [], groupOwnerMemoryEnabled: false, groupMemoryEnabled: true, memberMemoryEnabled: true }
  const admitted = vi.fn(async () => {})
  const connected = Promise.withResolvers<FeishuConnectionOptions>()
  const groupDispatch = Promise.withResolvers<Parameters<ReturnType<typeof createDesktopImDispatch>>[0]>()
  const gateway = createDesktopFeishuGateway({ read: async () => bot }, admitted, async options => {
    if (options.group) groupDispatch.resolve(options)
  }, () => ({ async request(request) {
    const response = request.url.includes('tenant_access_token') ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
      : { code: 0, bot: { open_id: 'ou_bot' } }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(response)) })(), cancel() {} }
  } }), async options => {
    connected.resolve(options)
    const closed = Promise.withResolvers<void>()
    return { closed: closed.promise, async stop() { await options.wsNetwork.close(); closed.resolve() } }
  })
  try {
    await gateway.start()
    const connection = await connected.promise
    await connection.onMessage({
      header: { event_type: 'im.message.receive_v1', app_id: appId, event_id: 'evt_group_1' },
      event: { sender: { sender_id: { open_id: 'ou_member' }, sender_type: 'user' }, message: {
        chat_type: 'group', chat_id: 'oc_group', message_id: 'om_group_1', message_type: 'text',
        content: '{"text":"@_user_ou_bot 帮我看看"}', mentions: [{ key: '@_user_ou_bot', name: '咕咕', id: { open_id: 'ou_bot' } }],
      } },
    }, new AbortController().signal)
    const dispatch = await groupDispatch.promise
    expect(dispatch.group).toMatchObject({ id: 'oc_group', ownerPlatformUserId: ownerId })
    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ platform: 'feishu', ownerId: 'desktop' }), expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({
      eventId: 'om_group_1', scope: expect.objectContaining({ platform: 'feishu', chatType: 'group', chatId: 'oc_group' }),
    }), undefined, expect.objectContaining({ files: [], authorize: expect.any(Function) }))
  } finally { await gateway.stop() }
})
