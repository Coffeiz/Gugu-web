import { rm } from 'node:fs/promises'
import { writeDesktopAgentAttachment } from '../../../agent/attachments.js'
import { createHash, randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import { imAdmissionKeys, rollbackImMedia, type ImConversationScope, type ImReceivedMessage } from '@gugu/gateway'
import type { IpcHost } from '../../../ipc/types.js'
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
}

export type DesktopImFile = { name: string; ext: string; mime: string; voice: boolean; transcript?: string; sourceIndex?: number; bytes: Uint8Array }

export function createDesktopImInbox(host: IpcHost, encryption: Pick<typeof safeStorage, 'isAsyncEncryptionAvailable' | 'encryptStringAsync'>,
  dataDirectory?: string) {
  return async (connectionId: string, event: ImReceivedMessage, replyContext?: string,
    media?: { files: DesktopImFile[]; sourceMessageId?: string; recordOnly?: boolean; ownerPlatformUserId?: string;
      sourceAttentionKind?: string; authorize(): Promise<boolean>; onAccepted?(ids: readonly string[]): Promise<void> }) => {
    if (!media?.recordOnly && !await encryption.isAsyncEncryptionAvailable())
      throw new DesktopError('credential_store', '无法加密本机 IM 收件')
    const eventKey = desktopImEventKey(event)
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
      if (media && !await media.authorize()) return
      retain = true
      const scope = { platform: event.scope.platform, connectionId, eventKey }
      const files = attachments ? { attachments } : {}
      const accepted = sealedEvent
        ? await host.request<boolean | null>('im.inbox.admit', { ...scope, sealedEvent: sealedEvent.toString('base64'), ...files, ...(media?.sourceMessageId ? { sourceMessageId: media.sourceMessageId } : {}) })
        : await host.request<boolean>('im.inbox.recordGroup', { ...scope, text: event.text, platformUserId: event.scope.platformUserId, platformUserName: event.platformUserName,
          ownerPlatformUserId: media?.ownerPlatformUserId, ...files })
      committed = accepted === true
      retain = accepted !== false
      if (accepted === true && attachments) await media?.onAccepted?.(attachments.map(file => file.attachId))
    } catch (error) {
      if (!committed && error instanceof DesktopError && (error.code === 'invalid_request' || error.code === 'busy')) retain = false
      throw error
    } finally {
      if (!retain) await rollbackImMedia(written, path => rm(path, { force: true }))
    }
  }
}
