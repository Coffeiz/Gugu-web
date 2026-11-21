import { qqPrivateReply } from '../../../packages/gateway/tests/fixtures/qq-private-reply.js'
import type { createDesktopImDispatch } from '../src/main/im/gateway/delivery/dispatch.js'
import { qqPrivateMessage } from '../../../packages/gateway/tests/fixtures/qq-private-message.js'
import { expect, it, vi } from 'vitest'
import type { QqConnectionPorts } from '@gugu/gateway/qq'
import { createDesktopQqGateway } from '../src/main/im/gateway/platforms/qq/index.js'

it('QQ 绑定消息只用于认证，随后只登记绑定用户的私聊', async () => {
  const bot = { appId: 'app', appSecret: 'synthetic-secret', userId: null as string | null, privateStreamingEnabled: false, groupChatEnabled: false, groupMessageFormat: 'compat' as 'compat' | 'markdown', groupReplyMode: 'reply_mentions' as 'reply_mentions' | 'reply_all' | 'record_only', privateMessageFormat: 'markdown' as 'compat' | 'markdown', enabled: true, revision: '1', bindingEventId: null as string | null }
  const admit = vi.fn(async (..._args: Parameters<Parameters<typeof createDesktopQqGateway>[1]>) => {})
  const consumeBinding = vi.fn(async (source: { userId: string; eventId: string }, text: string) => {
    if (text !== '123456') return false
    bot.userId = source.userId
    bot.bindingEventId = source.eventId
    return true
  })
  const connected = Promise.withResolvers<QqConnectionPorts>()
  const dispatch = Promise.withResolvers<Parameters<ReturnType<typeof createDesktopImDispatch>>[0]>()
  let groupDelivery: Parameters<ReturnType<typeof createDesktopImDispatch>>[0] | undefined
  const outbound: unknown[] = []
  const gateway = createDesktopQqGateway({ read: async () => bot, consumeBinding }, admit,
    async options => { if (options.group) groupDelivery = options; else dispatch.resolve(options) },
    () => ({ async request(input) {
      const path = new URL(input.url).pathname
      const auth = path.endsWith('/getAppAccessToken')
      if (!auth) outbound.push({ path, body: JSON.parse(Buffer.from(input.body as Uint8Array).toString()) })
      const result = auth ? { access_token: 'synthetic-access', expires_in: 7200 } : { id: 'synthetic-message' }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(result)) })(), cancel() {} }
    } }),
    options => {
      connected.resolve(options)
      const closed = Promise.withResolvers<void>()
      return { closed: closed.promise, async stop() { closed.resolve() } }
    }, undefined, undefined, {
      host: { async request<T>(method: string) { return (method === 'im.qq.sequence' ? 1 : null) as T } },
      encryption: {
        async isAsyncEncryptionAvailable() { return true },
        async encryptStringAsync() { return Buffer.from([1]) },
        async decryptStringAsync() { return { result: '', shouldReEncrypt: false } },
      },
    })
  try {
    await gateway.start()
    const { onEvent, onReadyChange } = await connected.promise
    await gateway.settled()
    expect(gateway.health().running).toBe(0)
    onReadyChange?.(true)
    expect(gateway.health().running).toBe(1)
    onReadyChange?.(false)
    expect(gateway.health().running).toBe(0)
    const signal = new AbortController().signal
    const message = (user: string, content: string) => ({ id: content === '123456' ? 'binding' : 'msg', author: { user_openid: user }, content })
    await onEvent('GROUP_MESSAGE_CREATE', message(qqPrivateMessage.author.user_openid, '123456'), signal)
    expect(consumeBinding).not.toHaveBeenCalled()
    await onEvent('C2C_MESSAGE_CREATE', message(qqPrivateMessage.author.user_openid, '123456'), signal)
    await onEvent('C2C_MESSAGE_CREATE', message(qqPrivateMessage.author.user_openid, '123456'), signal)
    expect(admit).not.toHaveBeenCalled()
    await onEvent('C2C_MESSAGE_CREATE', message('other', '测试'), signal)
    await onEvent('C2C_MESSAGE_CREATE', qqPrivateMessage, signal)
    const delivery = await dispatch.promise
    const reply = { version: 1, kind: 'reply.requested', ...qqPrivateReply,
      scope: { ...delivery.connection, chatType: 'c2c', chatId: null, platformUserId: qqPrivateReply.recipient } } as const
    expect(await delivery.send(reply)).toBe('accepted')
    expect(outbound).toEqual([{
      path: `/v2/users/${qqPrivateReply.recipient}/messages`,
      body: expect.objectContaining({ msg_id: 'binding', msg_type: 0, content: expect.stringContaining('身份已绑定') }),
    }, { path: `/v2/users/${qqPrivateReply.recipient}/messages`, body: expect.objectContaining({
      msg_id: qqPrivateReply.originalMessageId, msg_type: 2, markdown: { content: qqPrivateReply.text },
    }) }])
    bot.privateMessageFormat = 'compat'
    expect(await delivery.send(reply)).toBe('accepted')
    expect(outbound.at(-1)).toMatchObject({ body: { msg_type: 0, content: qqPrivateReply.text } })
    bot.enabled = false
    expect(await delivery.send(reply)).toBe('rejected')
    expect(outbound).toHaveLength(3)
    await onEvent('C2C_MESSAGE_CREATE', qqPrivateMessage, signal)
    expect(admit).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({
      eventId: qqPrivateMessage.id, text: qqPrivateMessage.content,
      scope: expect.objectContaining({ platform: 'qq', chatType: 'c2c', platformUserId: qqPrivateMessage.author.user_openid }),
    }))
    bot.enabled = true
    await onEvent('C2C_MESSAGE_CREATE', { ...qqPrivateMessage, id: 'broken-media',
      attachments: [{ filename: '示例.png', url: 'http://media.invalid/media.png' }] }, signal)
    expect(outbound.at(-1)).toMatchObject({
      body: { msg_id: 'broken-media', content: expect.stringContaining('暂时无法从 QQ 下载附件') },
    })
    expect(admit).toHaveBeenCalledOnce()
    const groupMessage = { ...qqPrivateMessage, id: 'group-message', group_openid: 'group-test' }
    await onEvent('GROUP_AT_MESSAGE_CREATE', groupMessage, signal)
    bot.groupChatEnabled = true
    await onEvent('GROUP_MESSAGE_CREATE', groupMessage, signal)
    await onEvent('GROUP_AT_MESSAGE_CREATE', { ...groupMessage, author: { member_openid: 'other' } }, signal)
    expect(admit).toHaveBeenCalledTimes(2)
    await onEvent('GROUP_AT_MESSAGE_CREATE', groupMessage, signal)
    expect(admit).toHaveBeenCalledTimes(3)
    expect(groupDelivery?.group?.id).toBe('group-test')
    expect(admit).toHaveBeenLastCalledWith(groupDelivery?.connectionId, expect.objectContaining({
      botMentioned: true, scope: expect.objectContaining({ chatType: 'group', chatId: 'group-test' }),
    }))
    bot.groupReplyMode = 'reply_all'
    await onEvent('GROUP_MESSAGE_CREATE', { ...groupMessage, id: 'unmentioned' }, signal)
    expect(admit).toHaveBeenCalledTimes(4)
    expect(admit).toHaveBeenLastCalledWith(groupDelivery?.connectionId, expect.objectContaining({
      eventId: 'unmentioned', botMentioned: false,
    }))

    await onEvent('GROUP_AT_MESSAGE_CREATE', { ...groupMessage, id: 'member-message', author: { member_openid: 'other' } }, signal)
    expect(admit).toHaveBeenCalledTimes(5)
    expect(admit).toHaveBeenLastCalledWith(groupDelivery?.connectionId, expect.objectContaining({
      scope: expect.objectContaining({ chatId: 'group-test', platformUserId: 'other' }),
    }))
    const member = admit.mock.lastCall?.[1]
    if (!member || !groupDelivery?.group) throw new Error('群成员消息未准入')
    expect(await groupDelivery.group.authorizeMessage(member)).toBe(true)
    bot.groupMessageFormat = 'markdown'
    expect(await groupDelivery.send({ ...reply, scope: member.scope, recipient: 'group-test', originalMessageId: 'member-message' })).toBe('accepted')
    expect(outbound.at(-1)).toMatchObject({ path: '/v2/groups/group-test/messages',
      body: { msg_type: 2, markdown: { content: qqPrivateReply.text } } })

    bot.groupReplyMode = 'record_only'
    expect(await groupDelivery.group.authorizeMessage(member)).toBe(false)
    const outboundCount = outbound.length
    await onEvent('GROUP_AT_MESSAGE_CREATE', { ...groupMessage, id: 'record-only-media',
      attachments: [{ filename: '示例.png', url: 'http://media.invalid/media.png' }] }, signal)
    expect(outbound).toHaveLength(outboundCount)

  } finally { await gateway.stop() }
})

it('桌面 QQ 引用与表情配对按连接隔离，并在重开后保留', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createDesktopQqReferences } = await import('../src/main/im/gateway/platforms/qq/references.js')
  const directory = await mkdtemp(join(tmpdir(), 'gugu-qq-reference-'))
  const signal = new AbortController().signal
  const scope = { platform: 'qq', ownerId: 'desktop', botId: 'bot', chatType: 'c2c', chatId: null, platformUserId: 'user' } as const
  const other = { ...scope, platformUserId: 'other' }
  const encryption = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) { return Buffer.from(value) },
    async decryptStringAsync(value: Buffer) { return { result: value.toString(), shouldReEncrypt: false } },
  }
  let now = 1_000
  const open = () => createDesktopQqReferences(directory, encryption, () => now)
  try {
    const refs = [{ face_type: '6', face_id: '1' }]
    const first = open()
    await first.remember(scope, 'index', { content: '测试引用', sender_id: 'user' }, signal)
    await first.rememberAttachments(scope, 'index', { 2: 'a'.repeat(32) }, signal)
    await first.queueFace(scope, 'face', refs, signal)
    expect(await first.takeFace(other, 'picture', signal)).toEqual([])
    const second = open()
    expect(await second.read(scope, 'index', signal)).toMatchObject({ content: '测试引用' })
    expect(await second.read(other, 'index', signal)).toBeNull()
    await second.remember(scope, 'index', { content: '测试引用', sender_id: 'user' }, signal)
    expect(await second.attachment(scope, 'index', 2, signal)).toBe('a'.repeat(32))
    expect(await second.attachment(other, 'index', 2, signal)).toBeNull()
    expect(await second.attachment(scope, 'index', 1, signal)).toBeNull()
    expect(await second.takeFace(scope, 'picture', signal)).toEqual(refs)
    expect(await open().takeFace(scope, 'picture', signal)).toEqual(refs)
    expect(await second.takeFace(scope, 'next-picture', signal)).toEqual([])
    now += 7 * 24 * 60 * 60 * 1_000
    expect(await second.read(scope, 'index', signal)).toBeNull()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each([false, true])('桌面 QQ 恢复原群收件时复核绑定（解密时撤权 %s）', async revoke => {
  const { createHash } = await import('node:crypto')
  const { desktopImEventKey } = await import('../src/main/im/gateway/inbound/inbox.js')
  const bot = { appId: 'bot', appSecret: 'synthetic', enabled: true, revision: '1', userId: 'owner',
    bindingEventId: null, privateMessageFormat: 'markdown' as const, privateStreamingEnabled: true, groupChatEnabled: true, groupHistorySearchEnabled: true, groupWebToolsEnabled: false, groupProviderSearchEnabled: false, groupReplyMode: 'reply_mentions' as 'reply_mentions' | 'record_only' }
  const event = { version: 1, kind: 'message.received', eventId: 'message', text: '测试群收件', quotedText: null, botMentioned: true,
    scope: { platform: 'qq', ownerId: 'desktop', botId: 'bot', chatType: 'group', chatId: 'group', platformUserId: 'owner' } } as const
  const connectionId = createHash('sha256').update(JSON.stringify(['qq-group', 'bot', 'group', 'owner'])).digest('hex')
  const connected = Promise.withResolvers<QqConnectionPorts>()
  const decoded = Promise.withResolvers<void>()
  const dispatch = vi.fn(async (_options: Parameters<ReturnType<typeof createDesktopImDispatch>>[0]) => {})
  const admit = vi.fn(async (..._args: Parameters<Parameters<typeof createDesktopQqGateway>[1]>) => {})
  const gateway = createDesktopQqGateway({ read: async () => ({ ...bot }), consumeBinding: async () => false }, admit, dispatch,
    () => ({ async request() { throw new Error('未预期的网络请求') } }),
    options => {
      connected.resolve(options)
      const closed = Promise.withResolvers<void>()
      return { closed: closed.promise, async stop() { closed.resolve() } }
    }, undefined, undefined, {
      host: { async request<T>(_method: string, params?: Record<string, unknown>) {
        return (params?.after ? null : { connectionId, eventKey: desktopImEventKey(event), sealedEvent: 'AQ==' }) as T
      } },
      encryption: {
        async isAsyncEncryptionAvailable() { return true },
        async encryptStringAsync() { return Buffer.from([1]) },
        async decryptStringAsync() {
          if (revoke) bot.groupChatEnabled = false
          decoded.resolve()
          return { result: JSON.stringify({ event }), shouldReEncrypt: false }
        },
      },
    })
  try {
    await gateway.start()
    const { onReadyChange, onEvent } = await connected.promise
    onReadyChange?.(true)
    await decoded.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    const groups = dispatch.mock.calls.map(([options]) => options).filter(options => options.group)
    expect(groups.map(options => options.connectionId)).toEqual(revoke ? [] : [connectionId])
    if (!revoke) {
      const receipt = { connectionId, eventKey: desktopImEventKey(event), sealedEvent: 'AQ==', name: 'group_context_search' }
      const signal = new AbortController().signal
      expect(await gateway.authorizeGroupTool(receipt, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'http_get' }, signal)).toBe(false)
      bot.groupWebToolsEnabled = true
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'http_get' }, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'similar_image_search' }, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'send_file' }, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'web_search' }, signal)).toBe(false)
      bot.groupWebToolsEnabled = false
      bot.groupProviderSearchEnabled = true
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'web_search' }, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'http_get' }, signal)).toBe(true)
      expect(await gateway.authorizeGroupTool({ ...receipt, name: 'list_projects' }, signal)).toBe(false)

      expect(await gateway.authorizeGroupTool({ ...receipt, connectionId: 'wrong' }, signal)).toBe(false)
      bot.groupHistorySearchEnabled = false
      expect(await gateway.authorizeGroupTool(receipt, signal)).toBe(false)
      bot.groupReplyMode = 'record_only'
      await onEvent('GROUP_AT_MESSAGE_CREATE', {
        id: 'record', group_openid: 'other-group', author: { member_openid: 'owner' }, content: '测试仅记录',
      }, new AbortController().signal)
      expect(admit).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ text: '测试仅记录' }), undefined,
        expect.objectContaining({ recordOnly: true, files: [] }))
      expect(dispatch.mock.calls.filter(([options]) => options.group)).toHaveLength(1)
    }
  } finally { await gateway.stop() }
})
