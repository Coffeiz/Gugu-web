import type { safeStorage } from 'electron'
import { imOutboundMediaLimits, parseImReceivedMessage, sendImMedia, type ImConnectionIdentity } from '@gugu/gateway'
import { readDesktopAgentAttachmentContent } from '../../../agent/attachments.js'
import type { createDesktopFileService } from '../../../files/service.js'
import { desktopImEventKey } from '../inbound/inbox.js'

type DesktopImMediaRouteBase = {
  connection: ImConnectionIdentity
  connectionId: string
  signal: AbortSignal
  authorize(): Promise<boolean>
  media: Parameters<typeof sendImMedia>[0]['platform']
}
export type DesktopImMediaRoute = DesktopImMediaRouteBase & (
  | { userId: string; group?: never }
  | { group: { id: string; ownerPlatformUserId: string; authorizeFile(event: ReturnType<typeof parseImReceivedMessage>): Promise<boolean> }; userId?: never }
)

export function createDesktopImAttachmentSender(directory: string,
  encryption: Pick<typeof safeStorage, 'decryptStringAsync'>,
  onQqUploadFailure?: Parameters<typeof sendImMedia>[0]['onQqUploadFailure'],
  onQqMessageFailure?: Parameters<typeof sendImMedia>[0]['onQqMessageFailure']) {
  const routes = new Map<string, DesktopImMediaRoute>()
  const key = (platform: string, connectionId: string) => `${platform}:${connectionId}`
  return {
    register(route: DesktopImMediaRoute) {
      const id = key(route.connection.platform, route.connectionId)
      routes.set(id, route)
      return () => { if (routes.get(id) === route) routes.delete(id) }
    },
    async send(params: Record<string, unknown>, signal?: AbortSignal, readFile?: ReturnType<typeof createDesktopFileService>['agentReadSendFile']) {
      const { platform, connectionId, eventKey, sealedEvent, attachId, attachment, filePath } = params
      if (typeof platform !== 'string' || typeof connectionId !== 'string' || typeof eventKey !== 'string'
        || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000
        || (filePath === undefined && (typeof attachId !== 'string' || !/^[0-9a-f]{32}$/.test(attachId)))
        || (filePath !== undefined && (typeof filePath !== 'string' || attachId !== undefined || !readFile))) return 'rejected'
      const id = key(platform, connectionId)
      const route = routes.get(id)
      if (!route || filePath !== undefined && !('userId' in route && route.userId)) return 'rejected'
      const active = AbortSignal.any([route.signal, ...(signal ? [signal] : [])])
      const authorize = async () => !active.aborted && routes.get(id) === route && await route.authorize() && !active.aborted && routes.get(id) === route
      let started = false
      try {
        if (!await authorize()) return 'rejected'
        const sealed = await encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
        const envelope = JSON.parse(sealed.result) as { event: unknown; replyContext?: unknown; attachments?: unknown }
        const event = parseImReceivedMessage(route.connection, envelope.event)
        if (desktopImEventKey(event) !== eventKey) return 'rejected'
        if ('group' in route && route.group) {
          if (event.scope.chatType !== 'group' || event.scope.chatId !== route.group.id
            || event.scope.platformUserId !== route.group.ownerPlatformUserId || !await route.group.authorizeFile(event)) return 'rejected'
        } else if (event.scope.chatType !== 'c2c' || event.scope.platformUserId !== route.userId) return 'rejected'
        const authorizeEvent = async () => await authorize() && (!('group' in route && route.group) || await route.group.authorizeFile(event))
        if (!await authorizeEvent()) return 'rejected'
        const maxBytes = imOutboundMediaLimits[route.connection.platform]
        let file: { name: string; ext: string; mime: string; data: Uint8Array; authorize?(): Promise<boolean> } | null
        if (typeof filePath === 'string' && readFile) {
          file = await readFile(filePath, active, maxBytes)
        } else {
          if (typeof attachId !== 'string' || !attachment || typeof attachment !== 'object') return 'rejected'
          // 私聊附件已由 Core 按当前会话校验，群聊还须匹配本次入站附件。
          if (event.scope.chatType === 'group'
            && (!Array.isArray(envelope.attachments) || !envelope.attachments.includes(attachId))) return 'rejected'
          const received = await readDesktopAgentAttachmentContent(directory, attachId, attachment as Parameters<typeof readDesktopAgentAttachmentContent>[2], maxBytes)
          file = { ...received, name: received.displayName }
        }
        const canSend = async () => {
          try { return await authorizeEvent() && (!file?.authorize || await file.authorize()) && await authorizeEvent() }
          catch { return false }
        }
        if (!file?.data.byteLength || !await canSend()) return 'rejected'
        started = true
        const sent = await sendImMedia({ platform: route.media, scope: event.scope, file, bytes: file.data,
          wechatContextToken: envelope.replyContext, feishuChatId: envelope.replyContext, signal: active, authorize: canSend, onQqUploadFailure, onQqMessageFailure })
        return sent?.receipt.outcome ?? 'rejected'
      } catch {
        return started ? 'unknown' : 'rejected'
      }
    },
  }
}
