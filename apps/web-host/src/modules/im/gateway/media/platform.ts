import { createImMediaBudget, rollbackImMedia } from '@gugu/gateway'
import type { ProviderTransport } from '@gugu/core/providers'
import { NodeProviderTransport, type AddressResolver } from '@gugu/core/providers/node'
import { readFeishuQuote, type ParsedFeishuMessage } from '@gugu/gateway/feishu'
import { processQqMedia, QqMediaIngressError, type ParsedQqMessage } from '@gugu/gateway/qq'
import type { TelegramInboundPayload } from '@gugu/gateway/telegram'
import type { WechatInboundPayload, WechatMediaRequirement } from '@gugu/gateway/wechat'
import { FeishuMediaIngressError, processFeishuMedia, type createFeishuClient } from '@gugu/gateway/feishu'
import type { createTelegramBotApi } from '@gugu/gateway/telegram'
import { createTelegramMediaIngress } from '../platforms/telegram/media.js'
import { processWechatImages, type createWechatMedia } from '@gugu/gateway/wechat'
import type { ImAttachmentScope, ImAttachmentStageInput, ImAttachmentReleaseInput, ImStagedAttachment } from '../inbound/attachments.js'

type Payload = Record<string, unknown>
type Scope = ImAttachmentScope
export type PlatformStagedAttachment = ImStagedAttachment
export interface PlatformAttachmentStore {
  stage(input: ImAttachmentStageInput, signal?: AbortSignal): Promise<PlatformStagedAttachment>
  reuse(input: { scope: Scope; sourcePlatformMessageId: string; sourceAttachmentIndex: number; targetPlatformMessageId: string }, signal?: AbortSignal): Promise<PlatformStagedAttachment | null>
  release(input: ImAttachmentReleaseInput): Promise<void>
}
const limit = 100 * 1024 * 1024
const invalid = () => new Error('IM 媒体接入未完成')
function checked(scope: Scope, value: PlatformStagedAttachment): PlatformStagedAttachment {
  if (!value || value.ownerId !== scope.ownerId || typeof value.attachId !== 'string' || !value.attachId ||
    typeof value.created !== 'boolean' || value.created && !value.creationReceipt) throw invalid()
  return value
}
/** 实际协议下载和已有owner暂存相接；raw URL/AES/平台file_id绝不进入普通payload。 */
export function createPlatformMedia(options: { storage: PlatformAttachmentStore; transport?: ProviderTransport; resolve?: AddressResolver }) {
  for (const name of ['stage', 'reuse', 'release'] as const) if (typeof options.storage?.[name] !== 'function') throw invalid()
  const transport = options.transport ?? new NodeProviderTransport({ trustEnvironment: false })
  async function batch(scope: Scope, signal: AbortSignal, work: (add: (input: Parameters<PlatformAttachmentStore['stage']>[0]) => Promise<string>, remember: (value: PlatformStagedAttachment) => string) => Promise<string[]>): Promise<string[]> {
    const created: PlatformStagedAttachment[] = []
    const remember = (value: PlatformStagedAttachment) => { checked(scope, value); if (value.created) created.push(value); return value.attachId }
    try { return await work(async input => { signal.throwIfAborted(); const value = remember(await options.storage.stage(input, signal)); signal.throwIfAborted(); return value }, remember) }
    catch (error) {
      await rollbackImMedia(created, value => options.storage.release({
        scope, attachId: value.attachId, creationReceipt: value.creationReceipt!,
      }))
      signal.throwIfAborted(); throw error instanceof QqMediaIngressError || error instanceof FeishuMediaIngressError ? error : invalid()
    }
  }
  return {
    async feishu(scope: Scope, parsed: ParsedFeishuMessage, client: ReturnType<typeof createFeishuClient>, botOpenId: string | null, signal: AbortSignal): Promise<Payload> {
      const payload: Payload = { ...parsed.payload }, source = String(payload.platform_message_id || payload.message_id)
      const quote = await readFeishuQuote(parsed, client, botOpenId, signal)
      if (quote) Object.assign(payload, quote)
      const ids = await batch(scope, signal, async add => {
        const ids: string[] = []
        await processFeishuMedia(parsed.mediaItems, client, { maxBytes: limit, signal }, async (file, index) => {
          ids.push(await add({ scope, sourcePlatformMessageId: source, sourceAttachmentIndex: index, ...file }))
        })
        return ids
      })
      payload.attachments = ids
      return payload
    },
    async qq(scope: Scope, parsed: ParsedQqMessage, signal: AbortSignal): Promise<Payload> {
      const payload: Payload = { ...parsed.payload }, source = String(payload.platform_message_id || payload.message_id)
      payload.attachments = await batch(scope, signal, async (add, remember) => {
        const ids: string[] = []; const budget = createImMediaBudget(limit)
        await processQqMedia(parsed.mediaItems, budget, signal, {
          transport, resolve: options.resolve,
          async quote(media, sourcePlatformMessageId) {
            const reused = await options.storage.reuse({ scope, sourcePlatformMessageId,
              sourceAttachmentIndex: media.attachmentIndex, targetPlatformMessageId: source }, signal)
            if (!reused) return false
            ids.push(remember(reused))
            return true
          },
          async file(media, file, index) {
            try {
              ids.push(await add({ scope, sourcePlatformMessageId: source, sourceAttachmentIndex: media.source === 'quote' ? media.attachmentIndex : index,
                ...file }))
            } catch {
              signal.throwIfAborted()
              throw new QqMediaIngressError('qq_media_stage')
            }
          },
        })
        return ids
      })
      if (parsed.splitFace.faceOnly && parsed.mediaItems.some(item => item.item.qface_generated === true) && (payload.attachments as string[]).length) payload.text = ''
      payload.emoji_refs = []; return payload
    },
    async telegram(scope: Scope, payload: TelegramInboundPayload, api: ReturnType<typeof createTelegramBotApi>, resolveToken: (input: { ownerId: string; botId: string }, signal?: AbortSignal) => Promise<string | null>, signal: AbortSignal, notice: (text: string) => Promise<void>): Promise<Payload | null> {
      const source = payload.attachment_source_message_id || `${scope.botId}:${payload.chat_id}:${payload.message_id}`
      const ingress = createTelegramMediaIngress({ api, resolveToken, storage: {
        stage: (input, signal) => options.storage.stage({ scope, sourcePlatformMessageId: source, sourceAttachmentIndex: input.attachmentIndex,
          name: input.name, ext: input.ext, mime: input.mime, bytes: input.data, voice: input.kind === 'voice' }, signal),
        reuse: (input, signal) => options.storage.reuse({ scope, sourcePlatformMessageId: input.platformMessageId, sourceAttachmentIndex: input.attachmentIndex, targetPlatformMessageId: source }, signal),
        release: input => options.storage.release({ scope, attachId: input.attachId, creationReceipt: input.creationReceipt }),
      } })
      try {
        const result = await ingress.ingest({ ownerId: scope.ownerId, botId: scope.botId, platformMessageId: source,
          attachments: payload.attachments, quotedAttachments: payload.quoted_attachments }, signal)
        if (result.failureNotice) await notice(result.failureNotice)
        return payload.text.trim() || result.attachmentIds.length ? { ...payload, attachments: result.attachmentIds, quoted_attachments: [] } : null
      } finally { await ingress.close() }
    },
    async wechat(scope: Scope, items: readonly WechatMediaRequirement[], payload: WechatInboundPayload, media: ReturnType<typeof createWechatMedia>, signal: AbortSignal): Promise<string[]> {
      return batch(scope, signal, async add => {
        const ids: string[] = []
        await processWechatImages(items, media, { maxBytes: limit, signal }, async (file, index, quoted) => {
          ids.push(await add({ scope, sourcePlatformMessageId: String(payload.platform_message_id || payload.message_id),
            sourceAttachmentIndex: index, ...file, quoted }))
        })
        return ids
      })
    },
    close: () => transport.close?.(),
  }
}
