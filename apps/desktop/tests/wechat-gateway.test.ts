import { encryptAesEcb } from '@gugu/gateway/wechat'
import { wechatPrivateReply } from '../../../packages/gateway/tests/fixtures/wechat-private-reply.js'
import { wechatPrivateMessage } from '../../../packages/gateway/tests/fixtures/wechat-private-message.js'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { createDesktopWechatGateway } from '../src/main/im/gateway/platforms/wechat/index.js'
import type { IpcHost } from '../src/main/ipc/types.js'
import type { createDesktopImDispatch } from '../src/main/im/gateway/delivery/dispatch.js'

it('微信桌面轮询只接受绑定私聊，回复携带原会话凭据，停用后停止发送', async () => {
  const bot = { botId: 'bot', userId: wechatPrivateMessage.from_user_id, token: 'synthetic-token', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: true, revision: '1' }
  const control = vi.fn(async (method: string) => method === 'im.inbox.status' ? { status: 'running' } : { outcome: 'requested' })
  const admitted = vi.fn(async () => {})
  const binding = Promise.withResolvers<Parameters<ReturnType<typeof createDesktopImDispatch>>[0]>()
  const requests: Record<string, unknown>[] = []
  const typingRequests: Record<string, unknown>[] = []
  let deliveredUpdates = false
  const cursors: string[] = []
  let committed: string | null = 'previous'
  const message = (fromUser: string, token: string, messageId: number, groupId?: string, text = '测试') => ({
    message_type: 1, message_id: messageId, from_user_id: fromUser, context_token: token, group_id: groupId,
    item_list: [{ type: 1, text_item: { text } }],
  })
  const key = Buffer.alloc(16, 7)
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const imageItem = { type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'synthetic-image' } } }
  const image = { ...wechatPrivateMessage, message_id: 5, item_list: [imageItem] }
  let downloads = 0
  const gateway = createDesktopWechatGateway({ read: async () => bot }, admitted,
    async options => { binding.resolve(options) },
    () => ({ async request(request, signal) {
      if (request.url.includes('/c2c/download')) {
        downloads++
        expect(request.headers).toEqual({})
        return { status: 200, headers: {}, body: (async function* () { yield encryptAesEcb(png, key) })(), cancel() {} }
      }
      let response: unknown = { ret: 0 }
      if (request.url.endsWith('/getupdates')) {
        cursors.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()).get_updates_buf)
        if (deliveredUpdates) await delay(60_000, undefined, { signal })
        deliveredUpdates = true
        response = { ret: 0, get_updates_buf: 'next', msgs: [
          message('other', 'other-context', 1), message(bot.userId, 'group-context', 2, 'group'),
          wechatPrivateMessage, { ...wechatPrivateMessage, message_id: 4 },
          { ...image, from_user_id: 'other', message_id: 6 }, image,
          { ...wechatPrivateMessage, message_id: 7, item_list: [{ type: 3, voice_item: {} }] },
          message('other', 'other-context', 8, undefined, '/stop'),
          message(bot.userId, 'status-context', 9, undefined, '/status'),
          message(bot.userId, 'stop-context', 10, undefined, '/stop'),
        ] }
      }
      if (request.url.endsWith('/getconfig')) response = { ret: 0, typing_ticket: 'synthetic-ticket' }
      if (request.url.endsWith('/sendtyping')) typingRequests.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()))
      if (request.url.endsWith('/sendmessage')) requests.push(JSON.parse(Buffer.from(request.body as Uint8Array).toString()).msg)
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(response)) })(), cancel() {} }
    } }), () => ({
      async read() { return committed },
      async write(value: string) {
        expect(admitted).toHaveBeenCalledTimes(3)
        committed = value
      },
    }), undefined, undefined, { request: control as IpcHost['request'] })
  try {
    await gateway.start()
    const dispatch = await binding.promise
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(3))
    for (const [index, id] of [3, 4].entries()) {
      expect(admitted).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({ platform: 'wechat', ownerId: 'desktop' }), expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.objectContaining({ eventId: `message:${id}`, text: wechatPrivateMessage.item_list[0]?.text_item.text,
          scope: expect.objectContaining({ chatType: 'c2c', platformUserId: bot.userId }) }), 'private-context')
    }
    expect(admitted).toHaveBeenNthCalledWith(3, expect.objectContaining({ platform: 'wechat', ownerId: 'desktop' }), expect.any(String),
      expect.objectContaining({ eventId: 'message:5', text: '' }), 'private-context',
      expect.objectContaining({ files: [expect.objectContaining({ bytes: png, mime: 'image/png' })] }))
    expect(downloads).toBe(1)
    await vi.waitFor(() => expect(cursors).toEqual(['previous', 'next']))
    expect(committed).toBe('next')
    expect(requests).toEqual([expect.objectContaining({
      to_user_id: bot.userId, context_token: 'private-context',
      item_list: [{ type: 1, text_item: { text: '没收到这条语音的转写，请重发语音或改用文字。' } }],
    }), expect.objectContaining({ to_user_id: bot.userId, context_token: 'status-context',
      item_list: [{ type: 1, text_item: { text: '当前任务仍在运行。' } }],
    }), expect.objectContaining({ to_user_id: bot.userId, context_token: 'stop-context',
      item_list: [{ type: 1, text_item: { text: '🛑 已停止当前任务' } }],
    })])
    expect(control.mock.calls.map(([method]) => method)).toEqual(['im.inbox.status', 'im.inbox.cancelRun'])
    requests.length = 0
    const stopTyping = dispatch.startTyping!('private-context')
    await vi.waitFor(() => expect(typingRequests).toEqual([
      expect.objectContaining({ ilink_user_id: bot.userId, typing_ticket: 'synthetic-ticket', status: 1 }),
    ]))
    await stopTyping()
    expect(typingRequests.map(request => request.status)).toEqual([1, 2])
    const reply = { version: 1, kind: 'reply.requested', recipient: wechatPrivateReply.recipient, text: wechatPrivateReply.text, deliveryId: wechatPrivateReply.deliveryId,
      originalMessageId: undefined, scope: { ...dispatch.connection, chatType: 'c2c', chatId: null, platformUserId: bot.userId } } as const
    expect(await dispatch.send(reply, wechatPrivateReply.contextToken)).toBe('accepted')
    expect(requests).toEqual([expect.objectContaining({ to_user_id: wechatPrivateReply.recipient, context_token: wechatPrivateReply.contextToken, client_id: wechatPrivateReply.deliveryId,
      item_list: [expect.objectContaining({ text_item: { text: wechatPrivateReply.text } })] })])
    bot.enabled = false
    expect(await dispatch.send(reply, wechatPrivateReply.contextToken)).toBe('rejected')
    expect(requests).toHaveLength(1)
  } finally { await gateway.stop() }
})
