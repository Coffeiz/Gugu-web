import { lookup as lookupMime } from 'mime-types'
import { createTelegramBotApi, TelegramApiError } from './telegram-api.js'

/** Python基准使用decimal MB，不能复用Bot API底层20MiB默认值。 */
export const TELEGRAM_INGRESS_MAX_BYTES = 20_000_000
const sizeNotice = 'Telegram 单个附件下载上限为 20 MB，超限附件未接收。'
const downloadNotice = '有附件暂时无法从 Telegram 下载，请稍后重试或重新发送。'
const stagingNotice = '有附件已从 Telegram 下载，但保存失败，请稍后重试或重新发送。'
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

export class TelegramMediaIngressError extends Error {
  constructor(readonly code: 'cancelled' | 'storage_contract' | 'reuse_failed' | 'cleanup_failed' | 'close_failed') {
    super('Telegram 媒体处理未完成'); this.name = 'TelegramMediaIngressError'
  }
}
export interface TelegramStagedAttachment {
  ownerId: string
  attachId: string
  /** 仅本次新创建的附件能清理，复用附件必须为false。 */
  created: boolean
  creationReceipt?: string
}
export interface TelegramMediaStageInput {
  ownerId: string
  botId: string
  name: string
  ext: string
  mime: string
  data: Uint8Array
  kind: 'image' | 'voice' | 'file'
  duration: number | null
  platform: 'telegram'
  platformMessageId: string | null
  attachmentIndex: number
}
export interface TelegramMediaStorage {
  /** 必须复核owner、Bot和来源消息，引用永远不从平台重新下载。 */
  reuse(input: { ownerId: string; botId: string; platform: 'telegram'; platformMessageId: string; attachmentIndex: number; quoted: true }, signal?: AbortSignal): Promise<{ ownerId: string; attachId: string; created?: boolean; creationReceipt?: string } | null>
  /** 必须落到真实owner暂存；voice由Host复用既有转换/语音链路，不假造ASR。失败须原子回滚。 */
  stage(input: TelegramMediaStageInput, signal?: AbortSignal): Promise<TelegramStagedAttachment>
  /** 只接受stage签发的本次创建收据；不能按任意附件ID或目录递归清理。 */
  release(input: { ownerId: string; attachId: string; creationReceipt: string }): Promise<void>
}
export interface TelegramMediaIngressInput {
  ownerId: string
  botId: string
  platformMessageId: string | null
  attachments: readonly unknown[]
  quotedAttachments: readonly unknown[]
}
function safeFilename(raw: unknown, mediaType: string): [string, string] {
  const fallback: Record<string, string> = { photo: 'jpg', voice: 'ogg', video: 'mp4', video_note: 'mp4', animation: 'mp4' }
  const leaf = typeof raw === 'string' && raw ? raw.replaceAll('\\', '/').split('/').at(-1)! : '附件'
  let filename = Array.from(leaf).filter(char => (char === ' ' || !/[\p{C}\p{Z}]/u.test(char)) && char !== '/' && char !== '\\').slice(0, 180).join('')
  if (!filename || filename === '.' || filename === '..') filename = '附件'
  const dot = filename.lastIndexOf('.')
  const name = dot > 0 && !filename.startsWith('.') ? filename.slice(0, dot) : filename
  const ext = dot > 0 && !filename.startsWith('.') ? Array.from(filename.slice(dot + 1).toLowerCase()).slice(0, 10).join('') : ''
  return [Array.from(name).slice(0, 160).join('') || '附件', ext || fallback[mediaType] || 'bin']
}
function mimeType(item: ObjectValue, ext: string, mediaType: string): string {
  const prefixes: Record<string, string> = { photo: 'image/', voice: 'audio/', audio: 'audio/', video: 'video/', video_note: 'video/', animation: 'video/' }
  const fallback: Record<string, string> = { photo: 'image/jpeg', voice: 'audio/ogg', audio: 'audio/mpeg', video: 'video/mp4', video_note: 'video/mp4', animation: 'video/mp4' }
  const candidate = typeof item.mime_type === 'string' ? item.mime_type : ''
  if (/^[A-Za-z0-9.+-]{1,127}\/[A-Za-z0-9.+-]{1,127}$/.test(candidate) && (!prefixes[mediaType] || candidate.toLowerCase().startsWith(prefixes[mediaType]!))) return candidate.toLowerCase()
  return fallback[mediaType] || lookupMime(`attachment.${ext}`) || 'application/octet-stream'
}
function validAttachment(value: { ownerId: string; attachId: string }, ownerId: string): boolean {
  return value.ownerId === ownerId && typeof value.attachId === 'string' && !!value.attachId && value.attachId.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.attachId)
}

export function createTelegramMediaIngress(options: {
  api?: Pick<ReturnType<typeof createTelegramBotApi>, 'call' | 'downloadFile'>
  /** 从可信Bot库检查owner/platform/enabled后解密，只在内存返回token。 */
  resolveToken(input: { ownerId: string; botId: string }, signal?: AbortSignal): Promise<string | null>
  storage: TelegramMediaStorage
}) {
  const ownedApi = options.api ? null : createTelegramBotApi()
  const api = options.api ?? ownedApi!
  const closing = new AbortController()
  const checkCancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new TelegramMediaIngressError('cancelled') }
  return {
    async ingest(input: TelegramMediaIngressInput, signal?: AbortSignal): Promise<{ attachmentIds: string[]; sizeLimitExceeded: boolean; failureNotice: string | null }> {
      signal = AbortSignal.any([closing.signal, ...(signal ? [signal] : [])])
      // owner/Bot/来源在第一次await前固定，调用方修改原对象不能更换暂存归属。
      input = { ...input }
      const raw = input.attachments.filter(object).map(item => ({ ...item })), quoted = input.quotedAttachments.filter(object).map(item => ({ ...item }))
      if (!input.ownerId || !input.botId) return { attachmentIds: [], sizeLimitExceeded: false, failureNotice: raw.length ? downloadNotice : null }
      const attachmentIds: string[] = [], created: { ownerId: string; attachId: string; creationReceipt: string }[] = []
      let sizeLimitExceeded = false, downloadFailed = false, stagingFailed = false, totalBytes = 0
      try {
        checkCancelled(signal)
        for (const item of quoted) {
          checkCancelled(signal)
          const source = item.source_platform_message_id
          if (typeof source !== 'string' || !source) continue
          const index = integer(item.source_attachment_index) && item.source_attachment_index >= 0 ? item.source_attachment_index : 0
          let reused: { ownerId: string; attachId: string; created?: boolean; creationReceipt?: string } | null
          try { reused = await options.storage.reuse({ ownerId: input.ownerId, botId: input.botId, platform: 'telegram', platformMessageId: source, attachmentIndex: index, quoted: true }, signal) }
          catch { checkCancelled(signal); throw new TelegramMediaIngressError('reuse_failed') }
          if (reused) {
            if (!validAttachment(reused, input.ownerId)) throw new TelegramMediaIngressError('storage_contract')
            if (reused.created) {
              if (!reused.creationReceipt) throw new TelegramMediaIngressError('storage_contract')
              created.push({ ownerId: input.ownerId, attachId: reused.attachId, creationReceipt: reused.creationReceipt })
            }
            attachmentIds.push(reused.attachId)
          }
        }
        checkCancelled(signal)
        if (!raw.length) return { attachmentIds, sizeLimitExceeded: false, failureNotice: null }
        let token: string | null
        try { token = await options.resolveToken({ ownerId: input.ownerId, botId: input.botId }, signal) }
        catch { checkCancelled(signal); token = null }
        checkCancelled(signal)
        if (!token) return { attachmentIds, sizeLimitExceeded: false, failureNotice: downloadNotice }
        for (const [index, item] of raw.entries()) {
          checkCancelled(signal)
          const fileId = item.file_id
          if (typeof fileId !== 'string' || !fileId || fileId.length > 512 || /[\x00-\x1f\x7f]/.test(fileId)) { downloadFailed = true; continue }
          if (integer(item.file_size) && item.file_size > TELEGRAM_INGRESS_MAX_BYTES) { sizeLimitExceeded = true; continue }
          if (totalBytes >= TELEGRAM_INGRESS_MAX_BYTES) { sizeLimitExceeded = true; continue }
          let downloaded = false
          try {
            const info = await api.call(token, 'getFile', { payload: { file_id: fileId }, signal })
            checkCancelled(signal)
            if (!object(info)) { downloadFailed = true; continue }
            if (integer(info.file_size) && info.file_size > TELEGRAM_INGRESS_MAX_BYTES) { sizeLimitExceeded = true; continue }
            const data = await api.downloadFile(token, typeof info.file_path === 'string' ? info.file_path : '', { maxBytes: TELEGRAM_INGRESS_MAX_BYTES, signal })
            checkCancelled(signal)
            if (!(data instanceof Uint8Array) || !data.byteLength || integer(info.file_size) && data.byteLength !== info.file_size) { downloadFailed = true; continue }
            totalBytes += data.byteLength
            if (data.byteLength > TELEGRAM_INGRESS_MAX_BYTES || totalBytes > TELEGRAM_INGRESS_MAX_BYTES) { sizeLimitExceeded = true; continue }
            downloaded = true
            const mediaType = typeof item.media_type === 'string' ? item.media_type : ''
            const [name, ext] = safeFilename(item.file_name, mediaType)
            const attachmentIndex = item.source_attachment_index === undefined ? index : item.source_attachment_index
            if (!integer(attachmentIndex) || attachmentIndex < 0) throw new Error()
            const staged = await options.storage.stage({ ownerId: input.ownerId, botId: input.botId, name, ext, mime: mimeType(item, ext, mediaType), data,
              kind: mediaType === 'photo' ? 'image' : mediaType === 'voice' ? 'voice' : 'file',
              duration: typeof item.duration === 'number' && Number.isFinite(item.duration) ? item.duration : null,
              platform: 'telegram', platformMessageId: input.platformMessageId, attachmentIndex }, signal)
            if (!staged || !validAttachment(staged, input.ownerId) || typeof staged.created !== 'boolean' || staged.created && (typeof staged.creationReceipt !== 'string' || !staged.creationReceipt))
              throw new TelegramMediaIngressError('storage_contract')
            if (staged.created) created.push({ ownerId: input.ownerId, attachId: staged.attachId, creationReceipt: staged.creationReceipt! })
            checkCancelled(signal)
            attachmentIds.push(staged.attachId)
          } catch (error) {
            checkCancelled(signal)
            if (error instanceof TelegramMediaIngressError) throw error
            if (error instanceof TelegramApiError && error.operation === 'getFile' && error.statusCode === 413) sizeLimitExceeded = true
            else if (downloaded) stagingFailed = true
            else downloadFailed = true
          }
        }
        return { attachmentIds, sizeLimitExceeded, failureNotice: [sizeLimitExceeded ? sizeNotice : '', downloadFailed ? downloadNotice : '', stagingFailed ? stagingNotice : ''].filter(Boolean).join('\n') || null }
      } catch (error) {
        let cleanupFailed = false
        for (const item of created.reverse()) {
          try { await options.storage.release(item) } catch { cleanupFailed = true }
        }
        if (cleanupFailed) throw new TelegramMediaIngressError('cleanup_failed')
        if (error instanceof TelegramMediaIngressError) throw error
        throw new TelegramMediaIngressError('storage_contract')
      }
    },
    async close(): Promise<void> {
      closing.abort()
      try { await ownedApi?.close() } catch { throw new TelegramMediaIngressError('close_failed') }
    },
  }
}
