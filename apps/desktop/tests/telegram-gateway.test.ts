import { writeDesktopAgentAttachment } from '../src/main/agent/attachments.js'
import type { IpcHost } from '../src/main/ipc/types.js'
import { telegramPrivateReply } from '../../../packages/gateway/tests/fixtures/private-replies.js'
import type { createDesktopImDispatch } from '../src/main/im/gateway/delivery/dispatch.js'
import { telegramPrivateMessage } from '../../../packages/gateway/tests/fixtures/telegram-private-message.js'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { connectTelegramPolling, createTelegramSender, TelegramApiError, type createTelegramAdapter } from '@gugu/gateway/telegram'
import { createDesktopTelegramGateway } from '../src/main/im/gateway/platforms/telegram/index.js'

it('Telegram 使用一次性私聊绑定码，收件箱仅保存绑定后的授权私聊并从持久游标续拉', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-telegram-'))
  const data = new Map<string, string>()
  const encryption = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const bytes = randomBytes(24)
      data.set(bytes.toString('hex'), value)
      return bytes
    },
    async decryptStringAsync(bytes: Buffer) {
      return { result: data.get(bytes.toString('hex'))!, shouldReEncrypt: false }
    },
  }
  const authorizedMessage = { ...telegramPrivateMessage, update_id: 4 }
  const photo = { ...authorizedMessage, update_id: 5, message: {
    ...authorizedMessage.message, message_id: 5, text: undefined,
    photo: [{ file_id: 'photo-test', file_size: 4, width: 10, height: 10 }],
  } }
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const downloads = vi.fn(async () => bytes)
  const attachId = 'a'.repeat(32)
  await writeDesktopAgentAttachment(directory, attachId, bytes)
  const reference = vi.fn(async () => ({
    attachId, storageKey: `agent-attachments/${attachId}`, name: '图片', ext: 'jpg',
    mime: 'image/jpeg', size: bytes.length, kind: 'image', transcript: null,
  }))
  const offsets: unknown[] = []
  const closed = vi.fn()
  const releaseConflict = Promise.withResolvers<void>()
  const releaseGroupMessages = Promise.withResolvers<void>()
  let conflict = true
  let bindingCode = ''
  const update = (id: number, sender: number, type: string, text: string) => ({
    update_id: id,
    message: { message_id: id, chat: { id: sender, type }, from: { id: sender, first_name: '示例' }, text },
  })
  const outbound: Array<Record<string, unknown>> = []
  const adapter: typeof createTelegramAdapter = ({ token }) => ({
    api: {
      async call(_token, method) {
        if (method === 'getFile') return { file_path: 'photos/image.jpg', file_size: bytes.length }
        if (token.endsWith('-invalid')) throw new TelegramApiError('getMe', 401, 401)
        return method === 'getMe' ? { id: 12345, username: 'test_bot' } : { url: '' }
      },
      downloadFile: downloads,
      async close() {},
    } as ReturnType<typeof createTelegramAdapter>['api'],
    sender: createTelegramSender({ token, api: { async call(_token, method, options) {
      if (method !== 'sendMessage' || options?.authorize && !await options.authorize()) throw new Error('发送未获允许')
      outbound.push(options?.payload ?? {})
      if (options?.payload?.reply_to_message_id === 8) throw new Error('提示发送结果未知')
      return { message_id: 11 }
    } } }),
    connect: options => {
      let first = true
      return connectTelegramPolling({
        ...options, token: '12345:synthetic-token-value-001',
        async sleep(_ms, signal) {
          if (!signal.aborted) await releaseConflict.promise
        },
        api: {
          async call(_token, method, request) {
            if (method === 'getMe') return { id: 12345, username: 'test_bot' }
            if (method === 'getWebhookInfo') return { url: '' }
            if (conflict) {
              conflict = false
              throw new TelegramApiError('getUpdates', 409, 409)
            }
            offsets.push(request?.payload?.offset)
            if (first && request?.payload?.offset === undefined) {
              first = false
              const bind = (id: number, sender: number, type: string, code: string) => {
                const event = update(id, sender, type, `/bind ${code}`)
                return { ...event, message: { ...event.message, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } }
              }
              const wrongCode = bindingCode === '000000' ? '000001' : '000000'
              return [bind(1, 99, 'group', bindingCode), bind(2, 99, 'private', wrongCode), bind(3, 42, 'private', bindingCode)]
            }
            if (first && request?.payload?.offset === 4) {
              await releaseGroupMessages.promise
              first = false
              return [
                authorizedMessage, photo,
                { update_id: 6, message: { ...update(6, 99, 'private', '').message, photo: photo.message.photo } },
                { ...update(7, -10055, 'supergroup', '@test_bot 群消息'), message: {
                  ...update(7, -10055, 'supergroup', '@test_bot 群消息').message,
                  from: { id: 42, first_name: '示例' }, entities: [{ type: 'mention', offset: 0, length: 9 }],
                } },
                { update_id: 8, message: { ...photo.message, message_id: 8, photo: [{ ...photo.message.photo[0], file_size: 20_000_001 }] } },
                { update_id: 9, message: { ...update(9, 42, 'private', '引用图片').message, reply_to_message: photo.message } },
                { update_id: 10, message: { ...update(10, 42, 'private', '外部引用').message,
                  reply_to_message: { ...photo.message, chat: { id: 99, type: 'private' } } } },
              ]
            }
            await delay(60_000, undefined, { signal: request?.signal })
            return []
          },
          close: closed,
        },
      })
    },
  })
  const admission = Promise.withResolvers<void>()
  const admit = vi.fn(() => admission.promise)
  const dispatched = Promise.withResolvers<Parameters<ReturnType<typeof createDesktopImDispatch>>[0]>()
  const dispatchOptions: Parameters<ReturnType<typeof createDesktopImDispatch>>[0][] = []
  const first = createDesktopTelegramGateway(directory, encryption, adapter, undefined, admit, async options => {
    dispatchOptions.push(options)
    dispatched.resolve(options)
  }, undefined, undefined, { request: reference as IpcHost['request'] })
  let reopened: ReturnType<typeof createDesktopTelegramGateway> | undefined
  try {
    await first.start()
    await expect(first.save({ token: '12345:synthetic-token-value-invalid' })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(await first.snapshot()).toMatchObject({ configured: false })
    const snapshot = await first.save({ token: '12345:synthetic-token-value-001' })
    expect(snapshot).toMatchObject({ configured: true, bound: false, enabled: true, groupChatEnabled: false })
    expect(snapshot).not.toHaveProperty('chatId')
    const issued = await first.bindingCode()
    expect(issued.binding?.code).toMatch(/^\d{6}$/u)
    bindingCode = issued.binding!.code
    expect(snapshot).not.toHaveProperty('token')
    await vi.waitFor(async () => expect((await first.snapshot()).status).toBe('conflict'))
    releaseConflict.resolve()
    await vi.waitFor(async () => expect(await first.snapshot()).toMatchObject({ bound: true }))
    await first.updateGroupSettings({ groupChatEnabled: true })
    releaseGroupMessages.resolve()
    await vi.waitFor(() => expect(offsets).toContain(4))
    await vi.waitFor(() => expect(admit).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({
      kind: 'message.received', eventId: String(authorizedMessage.update_id), text: telegramPrivateMessage.message.text,
      scope: expect.objectContaining({ chatType: 'c2c', platformUserId: String(telegramPrivateMessage.message.from.id) }),
    })))
    expect(offsets).not.toContain(11)
    expect((await first.snapshot()).messages).toEqual([])
    admission.resolve()
    await vi.waitFor(async () => {
      expect(offsets).toContain(11)
      expect(await first.snapshot()).toMatchObject({ status: 'connected', bound: true })
      expect((await first.snapshot()).binding).toBeUndefined()
      expect((await first.snapshot()).messages).toEqual([expect.objectContaining({ id: 4, text: '允许的消息' }), expect.objectContaining({ id: 5, text: '' }), expect.objectContaining({ id: 9, text: '引用图片' }), expect.objectContaining({ id: 10, text: '外部引用' })])
    })
    expect(admit).toHaveBeenCalledTimes(5)
    expect(admit).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({
      eventId: '7', scope: expect.objectContaining({ platform: 'telegram', chatType: 'group', chatId: '-10055' }),
    }), undefined, expect.objectContaining({ files: [], authorize: expect.any(Function) }))
    expect(dispatchOptions.some(options => 'group' in options && options.group?.id === '-10055')).toBe(true)
    expect(admit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: '5', text: '' }),
      undefined, expect.objectContaining({ files: [expect.objectContaining({ mime: 'image/jpeg', bytes })] }))
    expect(reference).toHaveBeenCalledWith('im.inbox.attachmentReference', expect.objectContaining({
      platform: 'telegram', sourceMessageId: '12345:42:5', sourceIndex: 0, connectionId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(reference.mock.calls.filter(([method]) => method === 'im.inbox.attachmentReference')).toHaveLength(1)
    expect(admit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: '9', text: '引用图片' }),
      undefined, expect.objectContaining({ files: [expect.objectContaining({ bytes: new Uint8Array(bytes) })] }))
    expect(admit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventId: '10', quotedText: null }))
    expect(downloads).toHaveBeenCalledOnce()
    const delivery = await dispatched.promise
    const reply = { version: 1, kind: 'reply.requested', ...telegramPrivateReply,
      scope: { ...delivery.connection, chatType: 'c2c', chatId: null, platformUserId: telegramPrivateReply.recipient } } as const
    expect(await delivery.send(reply)).toBe('accepted')
    expect(outbound).toEqual([
      expect.objectContaining({ chat_id: '99', text: expect.stringContaining('绑定码无效') }),
      expect.objectContaining({ chat_id: '42', text: '绑定成功。' }),
      expect.objectContaining({ chat_id: '42', reply_to_message_id: 8, text: expect.stringContaining('超限附件未接收') }),
      expect.objectContaining({
      chat_id: telegramPrivateReply.recipient, reply_to_message_id: Number(telegramPrivateReply.originalMessageId), text: telegramPrivateReply.text,
    })])
    await first.updateGroupSettings({ groupReplyMode: 'reply_all', groupAttentionMode: 'active',
      groupOwnerMemoryEnabled: true, groupHistorySearchEnabled: true })
    expect(await first.snapshot()).toMatchObject({ groupChatEnabled: true, groupReplyMode: 'reply_all',
      groupAttentionMode: 'active', groupOwnerMemoryEnabled: true, groupHistorySearchEnabled: true })
    await first.stop()
    expect(closed).toHaveBeenCalledTimes(2)
    offsets.length = 0
    reopened = createDesktopTelegramGateway(directory, encryption, adapter)
    await reopened.start()
    await vi.waitFor(() => expect(offsets[0]).toBe(11))
    expect(await reopened.snapshot()).toMatchObject({ groupChatEnabled: true, groupReplyMode: 'reply_all', groupAttentionMode: 'active',
      groupOwnerMemoryEnabled: true, groupHistorySearchEnabled: true })
    expect(outbound.filter(item => item.reply_to_message_id === 8)).toHaveLength(1)
    expect((await reopened.snapshot()).messages).toEqual([expect.objectContaining({ id: 4, text: '允许的消息' }), expect.objectContaining({ id: 5, text: '' }), expect.objectContaining({ id: 9, text: '引用图片' }), expect.objectContaining({ id: 10, text: '外部引用' })])
    expect(await reopened.disable()).toMatchObject({ enabled: false, status: 'disabled' })
    expect(closed).toHaveBeenCalledTimes(3)
  } finally {
    admission.resolve()
    releaseConflict.resolve()
    await reopened?.stop()
    await first.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
