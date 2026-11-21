import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDesktopImAttachmentSender } from '../src/main/im/gateway/delivery/attachments.js'
import { desktopImEventKey } from '../src/main/im/gateway/inbound/inbox.js'
import { writeDesktopAgentAttachment } from '../src/main/agent/attachments.js'

it('仅向仍授权的原会话发送密封收件中的本地附件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-send-'))
  try {
    const attachId = 'a'.repeat(32)
    const bytes = new Uint8Array([1, 2, 3])
    await writeDesktopAgentAttachment(directory, attachId, bytes)
    const connection = { platform: 'wechat', ownerId: 'desktop', botId: 'bot' } as const
    const event = { version: 1, kind: 'message.received', eventId: 'message:1', text: '', quotedText: null, botMentioned: false,
      scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'member' } } as const
    const encryption = { decryptStringAsync: async () => ({
      result: JSON.stringify({ event, replyContext: 'synthetic-context', attachments: [attachId] }), shouldReEncrypt: false,
    }) }
    const sender = createDesktopImAttachmentSender(directory, encryption)
    const file = vi.fn(async () => ({ outcome: 'accepted' as const }))
    let authorized = true
    const unregister = sender.register({ connection, connectionId: 'connection', userId: 'member',
      signal: new AbortController().signal, authorize: async () => authorized,
      media: { platform: 'wechat', sender: { file, image: vi.fn() } } })
    const request = { platform: 'wechat', connectionId: 'connection', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==',
      attachId, attachment: { storageKey: `agent-attachments/${attachId}`, name: '示例', ext: 'txt', mime: 'text/plain', size: bytes.length } }
    expect(await sender.send({ ...request, eventKey: 'other' })).toBe('rejected')
    expect(await sender.send({ ...request, attachId: 'b'.repeat(32) })).toBe('rejected')
    expect(await sender.send({ ...request, attachment: { ...request.attachment, name: '目录/示例' } })).toBe('rejected')
    expect(file).not.toHaveBeenCalled()
    expect(await sender.send(request)).toBe('accepted')
    expect(file).toHaveBeenCalledExactlyOnceWith({ userId: 'member', contextToken: 'synthetic-context' }, bytes, '示例.txt', expect.any(AbortSignal), expect.any(Function))
    authorized = false
    expect(await sender.send(request)).toBe('rejected')
    unregister()
    expect(await sender.send(request)).toBe('rejected')
    expect(file).toHaveBeenCalledOnce()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('QQ 群媒体投递复核原群、群工具权限与发言人，且拒绝群聊文件路径', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-send-group-'))
  try {
    const attachId = 'c'.repeat(32)
    const bytes = new Uint8Array([4, 5, 6])
    await writeDesktopAgentAttachment(directory, attachId, bytes)
    const connection = { platform: 'qq', ownerId: 'desktop', botId: 'bot' } as const
    const event = { version: 1, kind: 'message.received', eventId: 'group-message:1', text: '', quotedText: null, botMentioned: true,
      scope: { ...connection, chatType: 'group', chatId: 'group-1', platformUserId: 'owner-user' } } as const
    const encryption = { decryptStringAsync: async () => ({
      result: JSON.stringify({ event, attachments: [attachId] }), shouldReEncrypt: false,
    }) }
    const sender = createDesktopImAttachmentSender(directory, encryption)
    const upload = vi.fn(async () => ({ file_info: 'synthetic-file-info' }))
    const media = vi.fn(async () => ({ outcome: 'accepted' as const }))
    let authorized = true
    let fileAllowed = true
    const unregister = sender.register({ connection, connectionId: 'group-connection',
      group: { id: 'group-1', ownerPlatformUserId: 'owner-user', async authorizeFile(received) {
        return authorized && fileAllowed && received.scope.chatType === 'group' && received.scope.chatId === 'group-1'
      } },
      signal: new AbortController().signal, authorize: async () => authorized,
      media: { platform: 'qq', sender: { media }, mediaUpload: { upload } } })
    const request = { platform: 'qq', connectionId: 'group-connection', eventKey: desktopImEventKey(event), sealedEvent: 'AQ==',
      attachId, attachment: { storageKey: `agent-attachments/${attachId}`, name: '群附件', ext: 'png', mime: 'image/png', size: bytes.length } }
    expect(await sender.send({ ...request, eventKey: 'other' })).toBe('rejected')
    expect(await sender.send({ ...request, filePath: '/personal/private.txt', attachId: undefined })).toBe('rejected')
    expect(await sender.send(request)).toBe('accepted')
    expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: 'groups', openid: 'group-1', data: bytes }))
    expect(media).toHaveBeenCalledExactlyOnceWith({ id: 'group-1', chatType: 'group' }, expect.objectContaining({ fileInfo: 'synthetic-file-info' }), expect.any(AbortSignal), expect.any(Function))
    fileAllowed = false
    expect(await sender.send(request)).toBe('rejected')
    unregister()
    expect(await sender.send(request)).toBe('rejected')
    expect(upload).toHaveBeenCalledOnce()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
