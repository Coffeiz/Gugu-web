import type { ProviderTransport } from '@gugu/core/providers'
import { NodeProviderTransport } from '@gugu/core/providers/node'
import { normalizeQqFaces, normalizeQqAttachmentPlaceholders, type ParsedQqMessage } from '@gugu/core/im/qq-message'
import type { ImAttachmentScope } from '../../inbound/attachments.js'
import type { RedisCommandClient } from '../../../../../workers/redis-stream-queue.js'
import { createQqReferenceStore } from './reference-store.js'

type Value = Record<string, unknown>
interface QFaceAsset { url: string; filename: string; mime: 'image/png' }
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('QQ 消息引用或表情准备未完成')
const indexUrl = 'https://koishi.js.org/QFace/assets/qq_emoji/_index.json'
const assetsBase = 'https://koishi.js.org/QFace/'
const indexTtl = 6 * 3600 * 1000, failureDelay = 60_000
const facePattern = /<faceType=[^,>]+,faceId="[^"]*",ext="[^"]*">/gu

/** Python QFace选择顺序；只接受固定公共资源目录，不能由索引注入远程目标。 */
export function selectQqFaceAsset(index: readonly Value[], faceId: string): QFaceAsset | null {
  const id = faceId.trim()
  if (!id) return null
  const exact = index.filter(item => String(item.emojiId ?? '') === id)
  const fallback = index.filter(item => String(item.qzoneCode ?? '') === id && !exact.includes(item))
  for (const item of [...exact, ...fallback]) {
    const assets = Array.isArray(item.assets) ? item.assets.filter(object) : []
    const selected = assets.find(asset => asset.type === 2) ?? assets.find(asset => asset.type === 0)
    if (!selected || typeof selected.path !== 'string' || !selected.path.startsWith('assets/qq_emoji/') || selected.path.includes('..') ||
      !/^[A-Za-z0-9_./-]+$/u.test(selected.path)) continue
    return { url: assetsBase + selected.path, filename: String(selected.name || 'qq-face.png'), mime: 'image/png' }
  }
  return null
}

/** 仅在Core preflight通过后调用；独立Host服务负责引用持久恢复、本人FIFO和公共QFace索引。 */
export function createQqMessagePreparer(options: {
  redis: RedisCommandClient
  secretKey: string
  /** 每次准备均从当前Bot/账户策略复核，不能复用过期权限快照。 */
  authorize(scope: ImAttachmentScope, signal: AbortSignal): Promise<boolean>
  transport?: ProviderTransport
  now?(): number
  report?(code: 'qface-unavailable'): void
}) {
  if (typeof options.authorize !== 'function') throw invalid()
  const now = options.now ?? Date.now, references = createQqReferenceStore(options)
  const transport = options.transport ?? new NodeProviderTransport({ trustEnvironment: false })
  const lifetime = new AbortController()
  let index: Value[] | undefined, loadedAt = 0, retryAfter = 0, loading: Promise<Value[]> | undefined
  async function loadIndex(): Promise<Value[]> {
    if (index && now() - loadedAt < indexTtl) return index
    if (loading) return loading
    loading = (async () => {
      const response = await transport.request({ url: indexUrl, method: 'GET', headers: {}, timeoutMs: 3000 }, lifetime.signal)
      try {
        if (response.status !== 200) throw invalid()
        let size = 0; const chunks: Uint8Array[] = []
        for await (const chunk of response.body) { lifetime.signal.throwIfAborted(); size += chunk.byteLength; if (size > 4 * 1024 * 1024) throw invalid(); chunks.push(chunk) }
        const raw: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
        if (!Array.isArray(raw)) throw invalid()
        index = raw.filter(object); loadedAt = now(); return index
      } finally { await response.cancel() }
    })()
    try { return await loading } finally { loading = undefined }
  }
  async function systemFace(type: string, id: string, signal: AbortSignal): Promise<QFaceAsset | null> {
    if (!['1', '3'].includes(type) || !id.trim() || now() < retryAfter) return null
    try { const result = selectQqFaceAsset(await loadIndex(), id); signal.throwIfAborted(); return result }
    catch {
      signal.throwIfAborted()
      retryAfter = now() + failureDelay
      try { options.report?.('qface-unavailable') } catch { /* 增强能力故障只报告固定码，普通占位仍可处理。 */ }
      return null
    }
  }
  async function prepare(scope: ImAttachmentScope, input: ParsedQqMessage, signal: AbortSignal): Promise<ParsedQqMessage | null> {
    try {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted()
      scope = Object.freeze({ ...scope })
      const parsed = structuredClone(input), p = parsed.payload
      if (scope.platform !== 'qq' || p.platform !== 'qq' || p.owner_user_id !== scope.ownerId || p.bot_id !== scope.botId || p.channel_id !== scope.botId ||
        p.chat_type !== scope.chatType || p.platform_user_id !== scope.platformUserId || (p.chat_type === 'group' ? p.chat_id !== scope.chatId : scope.chatId !== null)) throw invalid()
      if (!await options.authorize(scope, signal)) throw invalid()
      signal.throwIfAborted()
      const messageIndex = String(parsed.indexEntry.message_index || '')
      if (!messageIndex || parsed.indexEntry.sender_id !== scope.platformUserId) throw invalid()
      // 此处之前必须完成秘密/绑定/交互/取消预检；不记录被消费控制消息的正文或签名URL。
      await references.remember(scope, messageIndex, parsed.indexEntry, signal)
      if (parsed.quoteRequest) {
        const entry = await references.read(scope, parsed.quoteRequest.referenceIndex, signal)
        if (entry) {
          p.reply_target_sender_id = typeof entry.sender_id === 'string' && entry.sender_id ? entry.sender_id : null
          p.reply_target_is_bot = typeof entry.sender_is_bot === 'boolean' ? entry.sender_is_bot : null
          if (parsed.quoteRequest.contentRequired) {
            const quoted = Array.isArray(entry.attachments) ? entry.attachments.filter(object) : []
            p.quoted_text = normalizeQqFaces(normalizeQqAttachmentPlaceholders(String(entry.content || ''), quoted)) || null
            if (quoted.length && p.quoted_text === '[QQ表情]') p.quoted_text = null
            parsed.mediaItems.push(...quoted.map((item, index) => ({ source: 'quote' as const, attachmentIndex: index,
              sourcePlatformMessageId: parsed.quoteRequest!.referenceIndex, item: { ...item, quoted: true, source_platform_message_id: parsed.quoteRequest!.referenceIndex, source_attachment_index: index } })))
          }
        }
      }
      if (parsed.splitFace.waitForImage) {
        await references.queueFace(scope, p.message_id, parsed.splitFace.emojiRefs, signal)
        return null
      }
      const ownMedia = parsed.mediaItems.filter(item => item.source === 'message')
      const pending = !p.qq_face_marker && ownMedia.length ? await references.takeFace(scope, p.message_id, signal) : []
      if (p.qq_face_marker || pending.length) for (const item of ownMedia) item.item.qq_face = true
      if (p.qq_face_marker && ownMedia.length) p.text = normalizeQqFaces(parsed.rawText.replace(facePattern, '').trim())
      if (pending.length) { p.text = ''; parsed.splitFace.emojiRefs = pending }
      if (p.emoji_refs.length && !parsed.mediaItems.length) {
        for (const ref of p.emoji_refs) {
          const asset = await systemFace(ref.face_type, ref.face_id, signal)
          if (!asset) continue
          parsed.mediaItems.push({ source: 'message', attachmentIndex: parsed.mediaItems.length, sourcePlatformMessageId: null,
            item: { url: asset.url, filename: asset.filename, content_type: asset.mime, qq_face: true,
              qq_face_type: ref.face_type, qq_face_id: ref.face_id, qface_generated: true } })
        }
      }
      if (parsed.splitFace.faceOnly && !parsed.mediaItems.length && !p.text.trim()) p.text = '[QQ表情]'
      p.attention_raw_text = p.text
      signal.throwIfAborted()
      // 网络索引查询可能跨过停用通知；媒体stage还会再次验证scope。
      if (!await options.authorize(scope, signal)) throw invalid()
      return parsed
    } catch { signal.throwIfAborted(); throw invalid() }
  }
  return { prepare, async close() { lifetime.abort(); if (loading) try { await loading } catch { /* 不输出第三方资源错误。 */ }; await transport.close?.() } }
}
