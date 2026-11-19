import type { ProviderTransport } from '@gugu/core/providers'
import { NodeProviderTransport, resolvePinnedTarget, type AddressResolver } from '@gugu/core/providers/node'
import { parseFeishuQuoteFacts, type ParsedFeishuMessage } from '@gugu/core/im/feishu-message'
import type { ParsedQqMessage } from '@gugu/core/im/qq-message'
import type { TelegramInboundPayload } from '@gugu/core/im/telegram-message'
import type { WechatInboundPayload, WechatMediaRequirement } from '@gugu/core/im/wechat-message'
import type { createFeishuClient } from './feishu/client.js'
import type { createTelegramBotApi } from './telegram-api.js'
import { createTelegramMediaIngress } from './telegram-media.js'
import type { createWechatMedia } from './wechat/media.js'
import type { ImAttachmentScope, ImAttachmentStageInput, ImAttachmentReleaseInput, ImStagedAttachment } from './attachment-ingress.js'

type Payload = Record<string, unknown>
type Scope = ImAttachmentScope
export type PlatformStagedAttachment = ImStagedAttachment
export interface PlatformAttachmentStore {
  stage(input: ImAttachmentStageInput, signal?: AbortSignal): Promise<PlatformStagedAttachment>
  reuse(input: { scope: Scope; sourcePlatformMessageId: string; sourceAttachmentIndex: number; targetPlatformMessageId: string }, signal?: AbortSignal): Promise<PlatformStagedAttachment | null>
  release(input: ImAttachmentReleaseInput): Promise<void>
}
const limit = 100 * 1024 * 1024
const object = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('IM 媒体接入未完成')
function filename(value: string): { name: string; ext: string } {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) || '附件', dot = leaf.lastIndexOf('.')
  return { name: Array.from((dot > 0 ? leaf.slice(0, dot) : leaf).replace(/[\x00-\x1f\x7f]/gu, '')).slice(0, 160).join('') || '附件',
    ext: dot > 0 ? leaf.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 10) || 'bin' : 'bin' }
}
function imageFormat(bytes: Uint8Array): { ext: string; mime: string } | null {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' }
  if (data.subarray(0, 4).toString() === 'GIF8') return { ext: 'gif', mime: 'image/gif' }
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}
function checked(scope: Scope, value: PlatformStagedAttachment): PlatformStagedAttachment {
  if (!value || value.ownerId !== scope.ownerId || typeof value.attachId !== 'string' || !value.attachId ||
    typeof value.created !== 'boolean' || value.created && !value.creationReceipt) throw invalid()
  return value
}
/** 实际协议下载和已有owner暂存相接；raw URL/AES/平台file_id绝不进入普通payload。 */
export function createPlatformMedia(options: { storage: PlatformAttachmentStore; transport?: ProviderTransport; resolve?: AddressResolver }) {
  for (const name of ['stage', 'reuse', 'release'] as const) if (typeof options.storage?.[name] !== 'function') throw invalid()
  const transport = options.transport ?? new NodeProviderTransport({ trustEnvironment: false })
  async function qqDownload(raw: unknown, signal: AbortSignal, remaining: number): Promise<Uint8Array> {
    if (typeof raw !== 'string' || !raw || /[\x00-\x20\x7f\\]/u.test(raw)) throw invalid()
    let url = raw.startsWith('http') ? raw : 'https://' + raw.replace(/^\/+/, '')
    for (let redirects = 0; redirects < 4; redirects++) {
      const safe = await resolvePinnedTarget(url, { signal, resolve: options.resolve })
      const response = await transport.request({ url: safe.url.href, method: 'GET', headers: {}, timeoutMs: 60_000 }, signal)
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'location')?.[1]
          if (!location) throw invalid()
          url = new URL(location, safe.url).href; continue
        }
        if (response.status !== 200) throw invalid()
        const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1]
        if (length && (!/^\d+$/u.test(length) || Number(length) > remaining)) throw invalid()
        const chunks: Uint8Array[] = []; let bytes = 0
        for await (const chunk of response.body) { signal.throwIfAborted(); bytes += chunk.byteLength; if (bytes > remaining) throw invalid(); chunks.push(chunk) }
        if (!bytes) throw invalid()
        return Buffer.concat(chunks, bytes)
      } finally { await response.cancel() }
    }
    throw invalid()
  }
  async function batch(scope: Scope, signal: AbortSignal, work: (add: (input: Parameters<PlatformAttachmentStore['stage']>[0]) => Promise<string>, remember: (value: PlatformStagedAttachment) => string) => Promise<string[]>): Promise<string[]> {
    const created: PlatformStagedAttachment[] = []
    const remember = (value: PlatformStagedAttachment) => { checked(scope, value); if (value.created) created.push(value); return value.attachId }
    try { return await work(async input => { signal.throwIfAborted(); const value = remember(await options.storage.stage(input, signal)); signal.throwIfAborted(); return value }, remember) }
    catch {
      for (const value of created.reverse()) try { await options.storage.release({ scope, attachId: value.attachId, creationReceipt: value.creationReceipt! }) } catch { /* 草稿TTL清理仍可恢复；不暴露底层路径。 */ }
      signal.throwIfAborted(); throw invalid()
    }
  }
  return {
    async feishu(scope: Scope, parsed: ParsedFeishuMessage, client: ReturnType<typeof createFeishuClient>, botOpenId: string | null, signal: AbortSignal): Promise<Payload> {
      const payload: Payload = { ...parsed.payload }, source = String(payload.platform_message_id || payload.message_id)
      const ids = await batch(scope, signal, async add => {
        const ids: string[] = []; let total = 0
        for (const [index, item] of parsed.mediaItems.entries()) {
          const bytes = await client.downloadResource(item.messageId, item.resourceKey, item.resourceType, { signal, maxBytes: limit - total })
          total += bytes.byteLength; if (!bytes.byteLength || total > limit) throw invalid()
          const format = item.resourceType === 'image' ? imageFormat(bytes) : null
          ids.push(await add({ scope, sourcePlatformMessageId: source, sourceAttachmentIndex: index, ...filename(item.fileName),
            mime: 'application/octet-stream', ...(format ?? {}), bytes, voice: item.isVoice }))
        }
        return ids
      })
      payload.attachments = ids
      if (parsed.quoteRequest) {
        const response = await client.call('GET', `/open-apis/im/v1/messages/${parsed.quoteRequest.messageId}?card_msg_content_type=user_card_content`, { signal })
        const data = object(response.data) ? response.data : response, item = Array.isArray(data.items) ? data.items[0] : null
        if (object(item) && item.chat_id === payload.chat_id) {
          const facts = parseFeishuQuoteFacts(item, botOpenId)
          payload.quoted_text = facts.text; payload.reply_target_sender_id = facts.sender_id; payload.reply_target_is_bot = facts.sender_is_bot
        }
      }
      return payload
    },
    async qq(scope: Scope, parsed: ParsedQqMessage, signal: AbortSignal): Promise<Payload> {
      const payload: Payload = { ...parsed.payload }, source = String(payload.platform_message_id || payload.message_id)
      payload.attachments = await batch(scope, signal, async (add, remember) => {
        const ids: string[] = []; let total = 0
        for (const [index, media] of parsed.mediaItems.entries()) {
          if (media.source === 'quote') {
            if (!media.sourcePlatformMessageId) continue
            const reused = await options.storage.reuse({ scope, sourcePlatformMessageId: media.sourcePlatformMessageId,
              sourceAttachmentIndex: media.attachmentIndex, targetPlatformMessageId: source }, signal)
            if (reused) ids.push(remember(reused))
            continue
          }
          const item = media.item
          let bytes: Uint8Array
          try { bytes = await qqDownload(item.url || item.file_url || item.download_url, signal, limit - total) }
          catch { signal.throwIfAborted(); if (item.qface_generated === true) continue; throw invalid() }
          const format = item.qq_face === true ? imageFormat(bytes) : null
          if (item.qface_generated === true && !format) continue
          total += bytes.byteLength
          ids.push(await add({ scope, sourcePlatformMessageId: source, sourceAttachmentIndex: index, ...filename(String(item.filename || item.file_name || '文件')),
            mime: String(item.content_type || item.type || 'application/octet-stream'), ...(format ?? {}), bytes, qqFace: item.qq_face === true }))
        }
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
        const ids: string[] = []; let total = 0
        for (const [index, item] of items.entries()) {
          if (item.kind !== 'image') continue
          const downloaded = await media.downloadImage(item.item, signal)
          if (!downloaded) continue
          total += downloaded.bytes.byteLength; if (total > limit) throw invalid()
          ids.push(await add({ scope, sourcePlatformMessageId: String(payload.platform_message_id || payload.message_id), sourceAttachmentIndex: index,
            name: '图片', ext: downloaded.ext, mime: downloaded.mime, bytes: downloaded.bytes, quoted: item.source === 'quote' }))
        }
        return ids
      })
    },
    close: () => transport.close?.(),
  }
}
