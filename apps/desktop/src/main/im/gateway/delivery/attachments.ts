import { downloadSendFileImage, type LinkButton } from '@gugu/core/tools'
import type { safeStorage } from 'electron'
import { imOutboundMediaLimits, parseImReceivedMessage, sendImMedia, sendImLinkButtons, type ImConnectionIdentity, type ImLinkButtonWire } from '@gugu/gateway'
import { readDesktopAgentAttachmentContent } from '../../../agent/attachments.js'
import type { createDesktopFileService } from '../../../files/service.js'
import { desktopImEventKey } from '../inbound/inbox.js'

type DesktopImMediaRouteBase = {
  connection: ImConnectionIdentity
  connectionId: string
  signal: AbortSignal
  authorize(): Promise<boolean>
  media?: Parameters<typeof sendImMedia>[0]['platform']
  linkMedia?: ImLinkButtonWire
}
export type DesktopImMediaRoute = DesktopImMediaRouteBase & (
  | { userId: string; group?: never }
  | { group: { id: string; ownerPlatformUserId: string;
    authorizeMessage?(event: ReturnType<typeof parseImReceivedMessage>): Promise<boolean>;
    authorizeFile(event: ReturnType<typeof parseImReceivedMessage>): Promise<boolean> }; userId?: never }
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
    async sendLinks(params: Record<string, unknown>, signal: AbortSignal) {
      const { platform, connectionId, eventKey, sealedEvent, message, buttons } = params
      if (typeof platform !== 'string' || typeof connectionId !== 'string' || typeof eventKey !== 'string'
        || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000 || typeof message !== 'string' || !Array.isArray(buttons))
        return { status: 'failed', delivery: 'none', buttonCount: 0 }
      const id = key(platform, connectionId)
      const route = routes.get(id)
      if (!route?.linkMedia) return { status: 'failed', delivery: 'none', buttonCount: 0 }
      const active = AbortSignal.any([route.signal, signal])
      const sealed = await encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
      const envelope = JSON.parse(sealed.result) as { event: unknown; replyContext?: unknown }
      const event = parseImReceivedMessage(route.connection, envelope.event)
      const { chatType, chatId, platformUserId } = event.scope
      const group = route.group
      if (desktopImEventKey(event) !== eventKey || (group
        ? chatType !== 'group' || chatId !== group.id
        : chatType !== 'c2c' || platformUserId !== route.userId))
        return { status: 'failed', delivery: 'none', buttonCount: 0 }
      const authorize = async () => !active.aborted && routes.get(id) === route && await route.authorize()
        && (!group || await group.authorizeMessage?.(event) === true) && !active.aborted && routes.get(id) === route
      const context = typeof envelope.replyContext === 'string' ? envelope.replyContext : undefined
      return sendImLinkButtons({
        wire: route.linkMedia, recipient: group ? group.id : platformUserId, chatType,
        contextToken: context, message, buttons: buttons as LinkButton[], signal: active, authorize,
      })
    },
    async send(params: Record<string, unknown>, signal?: AbortSignal, readFile?: ReturnType<typeof createDesktopFileService>['agentReadSendFile'],
      openImage?: Parameters<typeof downloadSendFileImage>[1], authorizeRemoteGroup?: (signal: AbortSignal) => Promise<boolean>) {
      const { platform, connectionId, eventKey, sealedEvent, attachId, attachment, filePath, url } = params
      if (typeof platform !== 'string' || typeof connectionId !== 'string' || typeof eventKey !== 'string'
        || typeof sealedEvent !== 'string' || sealedEvent.length > 48_000
        || (url !== undefined && (typeof url !== 'string' || url.length > 4096 || attachId !== undefined || filePath !== undefined || !openImage))
        || (url === undefined && filePath === undefined && (typeof attachId !== 'string' || !/^[0-9a-f]{32}$/.test(attachId)))
        || (filePath !== undefined && (typeof filePath !== 'string' || attachId !== undefined || !readFile))) return 'rejected'
      const id = key(platform, connectionId)
      const route = routes.get(id)
      if (!route?.media) return 'rejected'
      const active = AbortSignal.any([route.signal, ...(signal ? [signal] : [])])
      const authorize = async () => !active.aborted && routes.get(id) === route && await route.authorize() && !active.aborted && routes.get(id) === route
      let started = false
      try {
        if (!await authorize()) return 'rejected'
        const sealed = await encryption.decryptStringAsync(Buffer.from(sealedEvent, 'base64'))
        const envelope = JSON.parse(sealed.result) as { event: unknown; replyContext?: unknown }
        const event = parseImReceivedMessage(route.connection, envelope.event)
        if (desktopImEventKey(event) !== eventKey) return 'rejected'
        const group = route.group
        const authorizeGroupFile = async () => {
          if (!group) return true
          if (event.scope.chatType !== 'group' || event.scope.chatId !== group.id) return false
          const owner = event.scope.platformUserId === group.ownerPlatformUserId
          if (typeof url === 'string') return await authorizeRemoteGroup?.(active) === true
          if (typeof filePath === 'string') return owner && await authorizeRemoteGroup?.(active) === true
          return owner && await group.authorizeFile(event)
        }
        if (!group && (event.scope.chatType !== 'c2c' || event.scope.platformUserId !== route.userId)) return 'rejected'
        const authorizeEvent = async () => await authorize() && await authorizeGroupFile()
        if (!await authorizeEvent()) return 'rejected'
        const maxBytes = imOutboundMediaLimits[route.connection.platform]
        let file: { name: string; ext: string; mime: string; data: Uint8Array; authorize?(): Promise<boolean> } | null
        if (typeof url === 'string' && openImage) {
          const image = await downloadSendFileImage(url, openImage, active)
          if ('error' in image || image.bytes.byteLength > maxBytes) return 'rejected'
          file = { name: '图片', ext: image.ext, mime: image.mime, data: image.bytes }
        } else if (typeof filePath === 'string' && readFile) {
          file = await readFile(filePath, active, maxBytes)
        } else {
          if (typeof attachId !== 'string' || !attachment || typeof attachment !== 'object') return 'rejected'
          // Core 已校验附件归属当前会话，群聊发送者权限由 authorizeGroupFile 复核。
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
          qqReplyMessageId: event.scope.platform === 'qq' ? event.eventId : undefined,
          wechatContextToken: envelope.replyContext, feishuChatId: envelope.replyContext, signal: active, authorize: canSend, onQqUploadFailure, onQqMessageFailure })
        return sent?.receipt.outcome ?? 'rejected'
      } catch {
        return started ? 'unknown' : 'rejected'
      }
    },
  }
}
