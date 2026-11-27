import { consumeDesktopImText } from '../interactions/text.js'
import { rm } from 'node:fs/promises'
import { writeDesktopAgentAttachment } from '../../../agent/attachments.js'
import { createHash, randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import { imAdmissionKeys, receiveMessage, rollbackImMedia, type ImConnectionIdentity, type ImConversationScope, type ImReceivedMessage } from '@gugu/gateway'
import type { IpcHost } from '../../../ipc/types.js'
import type { createDesktopAgentModelService } from '../../../agent/model.js'
import { parseImControlCommand } from '@gugu/core/im/shortcut'
import { DesktopError } from '../../../core-host.js'

export function desktopImEventKey({ scope, eventId }: { scope: ImConversationScope; eventId: string }): string {
  return imAdmissionKeys({ ...scope, eventId }, value =>
    createHash('sha256').update(JSON.stringify(['desktop-im', 'message.received', value])).digest('hex'),
  ).eventHash
}

export interface DesktopImEnvelope {
  event: ImReceivedMessage
  replyContext?: string
  attachments?: string[]
  sourceAttentionKind?: string
  pendingAskResume?: boolean
}

export type DesktopImFile = { name: string; ext: string; mime: string; voice: boolean; transcript?: string; quoted?: boolean; sourceIndex?: number; bytes: Uint8Array }

export function createDesktopImInbox(host: IpcHost, encryption: Pick<typeof safeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync'>,
  dataDirectory?: string, model?: Pick<ReturnType<typeof createDesktopAgentModelService>, 'resolveRunModel'>) {
  return async (connection: ImConnectionIdentity, connectionId: string, event: ImReceivedMessage, replyContext?: string,
    media?: { files: DesktopImFile[]; sourceMessageId?: string; recordOnly?: boolean; ownerPlatformUserId?: string;
      sourceAttentionKind?: string; authorize(): Promise<boolean>; onAccepted?(ids: readonly string[]): Promise<void> }): Promise<boolean> => {
    const receipt = await receiveMessage(connection, event, {
      async recordInbound(event) {
        const eventKey = desktopImEventKey(event)
        if (model && event.scope.chatType === 'c2c' && !media?.recordOnly && !media?.files.length && event.text.trim() && !parseImControlCommand(event.text.trim())) {
          if (media && !await media.authorize()) return { status: 'ignored' }
          const answer = await consumeDesktopImText(host, model, event, connectionId, eventKey, media?.authorize ?? (async () => true))
          if (answer) return { status: answer.status === 'replay' ? 'duplicate' : 'recorded' }
        }
        if (!media?.recordOnly && !await encryption.isAsyncEncryptionAvailable())
          throw new DesktopError('credential_store', '无法加密本机 IM 收件')
        const attachments = media?.files.map(({ bytes, ...file }) => ({
          ...file, attachId: randomUUID().replaceAll('-', ''), size: bytes.byteLength,
        }))
        const sealedEvent = media?.recordOnly ? null : await encryption.encryptStringAsync(JSON.stringify({
          event, replyContext, attachments: attachments?.map(file => file.attachId),
          ...(media?.sourceAttentionKind ? { sourceAttentionKind: media.sourceAttentionKind } : {}),
        } satisfies DesktopImEnvelope))
        const written: string[] = []
        let retain = false
        let committed = false
        try {
          if (media && attachments?.length) {
            if (!dataDirectory) throw new DesktopError('storage_error', 'IM 附件存储目录不可用')
            for (const [index, attachment] of attachments.entries())
              written.push(await writeDesktopAgentAttachment(dataDirectory, attachment.attachId, media.files[index]!.bytes))
          }
          if (media && !await media.authorize()) return { status: 'ignored' }
          retain = true
          const scope = { platform: event.scope.platform, connectionId, eventKey }
          const files = attachments ? { attachments } : {}
          const accepted = sealedEvent
            ? await host.request<boolean>('im.inbox.admit', { ...scope, sealedEvent: sealedEvent.toString('base64'), ...files, ...(media?.sourceMessageId ? { sourceMessageId: media.sourceMessageId } : {}) })
            : await host.request<boolean>('im.inbox.recordGroup', { ...scope, text: event.text, platformUserId: event.scope.platformUserId, platformUserName: event.platformUserName,
              quotedText: event.quotedText ?? undefined, platformBotUserId: event.platformBotUserId, otherBotNames: event.otherBotNames,
              platformSentMs: event.platformSentMs, eventReceivedMs: event.eventReceivedMs,
              ownerPlatformUserId: media?.ownerPlatformUserId, ...files })
          committed = accepted === true
          retain = accepted
          if (accepted && attachments) await media?.onAccepted?.(attachments.map(file => file.attachId))
          return { status: accepted ? (sealedEvent ? 'queued' : 'recorded') : 'duplicate' }
        } catch (error) {
          if (!committed && error instanceof DesktopError && (error.code === 'invalid_request' || error.code === 'busy')) retain = false
          throw error
        } finally {
          if (!retain) await rollbackImMedia(written, path => rm(path, { force: true }))
        }
      },
    })
    return receipt.status === 'queued' || receipt.status === 'recorded'
  }
}
