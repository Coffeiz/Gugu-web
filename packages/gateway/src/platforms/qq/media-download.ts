import type { QqMediaRequirement } from './message.js'
import { imImageFormat, imMediaFilename } from '../../runtime/media-format.js'
import type { ProviderTransport } from '@gugu/core/providers'
import { resolvePinnedTarget, type AddressResolver } from '@gugu/core/providers/node'

export class QqMediaIngressError extends Error {
  constructor(readonly code: 'qq_media_address' | 'qq_media_download' | 'qq_media_size' | 'qq_media_stage',
    readonly httpStatus?: number) {
    super('IM 媒体接入未完成')
  }

  get notice() {
    if (this.code === 'qq_media_size') return 'QQ 附件超出大小限制，请缩小后重新发送。'
    if (this.code === 'qq_media_stage') return 'QQ 附件处理失败，请稍后重新发送。'
    return '暂时无法从 QQ 下载附件，请稍后重新发送。'
  }
}

export async function downloadQqMedia(raw: unknown, signal: AbortSignal, remaining: number, options: {
  transport: Pick<ProviderTransport, 'request'>
  resolve?: AddressResolver
}): Promise<Uint8Array> {
  if (typeof raw !== 'string' || !raw || /[\x00-\x20\x7f\\]/u.test(raw)) throw new QqMediaIngressError('qq_media_address')
  let url = raw.startsWith('http') ? raw : 'https://' + raw.replace(/^\/+/, '')
  for (let redirects = 0; redirects < 4; redirects++) {
    const safe = await resolvePinnedTarget(url, { signal, resolve: options.resolve }).catch(() => {
      signal.throwIfAborted()
      throw new QqMediaIngressError('qq_media_address')
    })
    const response = await options.transport.request({ url: safe.url.href, method: 'GET', headers: {}, timeoutMs: 60_000 }, signal)
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'location')?.[1]
        if (!location) throw new QqMediaIngressError('qq_media_address', response.status)
        try { url = new URL(location, safe.url).href }
        catch { throw new QqMediaIngressError('qq_media_address', response.status) }
        continue
      }
      if (response.status !== 200) throw new QqMediaIngressError('qq_media_download', response.status)
      const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1]
      if (length && !/^\d+$/u.test(length)) throw new QqMediaIngressError('qq_media_download', response.status)
      if (length && Number(length) > remaining) throw new QqMediaIngressError('qq_media_size')
      const chunks: Uint8Array[] = []; let bytes = 0
      for await (const chunk of response.body) {
        signal.throwIfAborted()
        bytes += chunk.byteLength
        if (bytes > remaining) throw new QqMediaIngressError('qq_media_size')
        chunks.push(chunk)
      }
      if (!bytes) throw new QqMediaIngressError('qq_media_download', response.status)
      return Buffer.concat(chunks, bytes)
    } finally { await response.cancel() }
  }
  throw new QqMediaIngressError('qq_media_address')
}

const qqVoiceExtensions = new Set(['amr', 'silk', 'slk', 'ogg', 'opus', 'wav', 'mp3', 'm4a', 'aac', 'flac'])

/** 根据实际图片字节确定格式，保留 QQ 语音和表情语义。 */
export function describeQqMedia(item: Readonly<Record<string, unknown>>, bytes: Uint8Array) {
  const format = imImageFormat(bytes)
  if (item.qface_generated === true && !format) return null
  const file = imMediaFilename(String(item.filename || item.file_name || '文件'))
  const mime = String(item.content_type || item.type || '').split(';', 1)[0]!.trim().toLowerCase()
  const validMime = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(mime) ? mime : 'application/octet-stream'
  const voice = !item.qq_face && (mime.startsWith('audio/') || qqVoiceExtensions.has(file.ext))
  return { ...file, mime: validMime, ...(format ?? {}), voice, qqFace: item.qq_face === true }
}

/** 直传、引用图片与表情补图共用下载规则。 */
export async function materializeQqMedia(
  item: Readonly<Record<string, unknown>>,
  budget: { readonly remaining: number; consume(size: number): boolean },
  signal: AbortSignal,
  options: Parameters<typeof downloadQqMedia>[3],
) {
  let bytes: Uint8Array
  try {
    if (!budget.remaining) throw new QqMediaIngressError('qq_media_size')
    bytes = await downloadQqMedia(item.url || item.file_url || item.download_url, signal, budget.remaining, options)
  } catch (error) {
    signal.throwIfAborted()
    if (item.qface_generated === true) return null
    throw error instanceof QqMediaIngressError ? error : new QqMediaIngressError('qq_media_download')
  }
  const metadata = describeQqMedia(item, bytes)
  if (!metadata) return null
  if (!budget.consume(bytes.byteLength)) throw new QqMediaIngressError('qq_media_size')
  return { ...metadata, bytes }
}

/** 顺序处理直传与引用；宿主提供会话授权和附件存储。 */
export async function processQqMedia(
  items: readonly QqMediaRequirement[],
  budget: Parameters<typeof materializeQqMedia>[1],
  signal: AbortSignal,
  options: Parameters<typeof downloadQqMedia>[3] & {
    authorize?: () => Promise<boolean>
    quote: (media: QqMediaRequirement, sourceId: string) => Promise<boolean>
    file: (media: QqMediaRequirement, file: NonNullable<Awaited<ReturnType<typeof materializeQqMedia>>>, index: number) => Promise<void>
  },
): Promise<boolean> {
  for (const [index, media] of items.entries()) {
    signal.throwIfAborted()
    if (options.authorize && !await options.authorize()) return false
    const quoted = media.source === 'quote'
    if (quoted) {
      if (media.sourcePlatformMessageId && await options.quote(media, media.sourcePlatformMessageId)) continue
      const mime = String(media.item.content_type || media.item.type || '').split(';', 1)[0]!.trim().toLowerCase()
      if (mime.includes('/') && mime !== 'application/octet-stream' && !mime.startsWith('image/')) continue
      if (!media.item.url && !media.item.file_url && !media.item.download_url) continue
      signal.throwIfAborted()
      if (options.authorize && !await options.authorize()) return false
    }
    const file = await materializeQqMedia(media.item, budget, signal, options)
    // 引用语音必须走同会话附件复用，保留原消息证明。
    if (!file) continue
    if (!quoted) await options.file(media, file, index)
    else if (imImageFormat(file.bytes)) await options.file(media, { ...file, voice: false }, index)
  }
  signal.throwIfAborted()
  return true
}
