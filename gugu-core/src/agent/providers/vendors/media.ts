import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { JsonObject, MediaLimits, ProviderConfig, ProviderDriverDependencies } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { requestJson } from '../http.js'
import { record } from '../values.js'

export const DEFAULT_MEDIA_LIMITS: MediaLimits = Object.freeze({
  audio_max_bytes: 36 * 1024 * 1024, video_source_max_bytes: 500 * 1024 * 1024,
  max_duration_s: 120, duration_limit_inclusive: true, max_size_bytes: 90 * 1024 * 1024,
  image_max_bytes: null, image_mimes: [], image_extensions: [], preserve_image_source: false,
  transcode_video: true, video_mimes: [], compress_max_dim: 1920, compress_bitrate: '5M',
  compress_trigger_bitrate: 16 * 1024 * 1024, transcode_video_mimes: [],
  base64_max: 45 * 1024 * 1024, prefer_file_upload: false, inline_max_bytes: 36 * 1024 * 1024,
})
export const MINIMAX_M3_MEDIA_LIMITS: MediaLimits = Object.freeze({
  ...DEFAULT_MEDIA_LIMITS, video_source_max_bytes: 512_000_000,
  max_duration_s: 1800, duration_limit_inclusive: false, max_size_bytes: 512_000_000,
  image_max_bytes: 10_000_000, image_mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  image_extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'], preserve_image_source: true,
  transcode_video: false, video_mimes: ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska'],
  base64_max: 4 * 1024 * 1024, prefer_file_upload: true,
})
export const MIMO_AUDIO_NATIVE_EXTS = Object.freeze(['mp3', 'wav', 'flac', 'm4a', 'ogg'])
export const minimaxSupportsImage = (model: string) => model.toLowerCase().startsWith('minimax-m3')
export const minimaxSupportsVideo = (model: string) => model.toLowerCase().includes('m3')
export const minimaxMediaLimits = (model: string): MediaLimits => minimaxSupportsVideo(model) ? MINIMAX_M3_MEDIA_LIMITS : DEFAULT_MEDIA_LIMITS

const mediaMessages = {
  video_duration_unknown: '无法确认视频时长，未发送给 Provider',
  video_duration_limit: '视频时长超过 1800 秒限制，未发送给 Provider',
  video_size_limit: '视频文件超过 MiniMax 的 512 MB 限制，未发送给 Provider',
  image_size_limit: '图片超过当前 Provider 的输入大小限制，未发送给 Provider',
  asr_duration_unknown: '无法确认音频时长，未发送到语音识别服务',
  asr_duration_limit: '音频时长超过语音识别服务的 500 秒上限，未发送到识别服务',
  asr_size_limit: '音频文件超过 MiniMax ASR 的 50 MB 限制，未发送到识别服务',
  asr_pcm: 'MiniMax ASR 不支持无容器的 PCM 音频，未发送到识别服务',
  asr_conversion: '当前语音识别服务不支持该音频格式，且无法转换为受支持格式',
  invalid_encoding: '音频数据编码无效，未发送到识别服务',
} as const
/** 媒体预检只使用固定文案与声明的限制，不回显文件名或媒体正文。 */
export class VendorMediaError extends ProviderError {
  constructor(readonly mediaReason: keyof typeof mediaMessages) {
    super(mediaReason === 'asr_pcm' || mediaReason === 'asr_conversion' ? 'unsupported' : 'input_rejected')
    this.name = 'VendorMediaError'; this.message = mediaMessages[mediaReason]
  }
}

export interface VendorMediaSource {
  readonly name: string
  readonly mime: string
  readonly size: number
  /** 仅可信媒体探测器生成，不得直接使用用户填报的时长。 */
  readonly duration?: number
  /** 二选一。stream由授权媒体层打开并持有；Provider不读取用户FS。 */
  readonly bytes?: Uint8Array
  readonly stream?: () => AsyncIterable<Uint8Array>
}
export interface VendorMediaDependencies extends ProviderDriverDependencies {
  probeVideo?(source: VendorMediaSource, signal: AbortSignal): Promise<{ duration: number | null }>
}

function checkedKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !/^[\x21-\x7e]+$/.test(value.trim())) throw new ProviderError('authentication')
  return value.trim()
}
const encoder = new TextEncoder()
function safeFileName(value: string): string { return (value.split(/[\\/]/).at(-1) || 'media').replace(/["\r\n]/g, '_') }

/** 分块multipart不会把大型原视频复制成整份bytes；取消会关闭源迭代器。 */
export function multipartBody(fields: Readonly<Record<string, string>>, file: {
  name: string; mime: string; source: AsyncIterable<Uint8Array>
}, boundary: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{1,70}$/.test(boundary) || /[\r\n]/.test(file.mime)) throw new ProviderError('input_rejected')
  return (async function* () {
    for (const [name, value] of Object.entries(fields)) {
      throwIfCancelled(signal)
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ProviderError('input_rejected')
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    }
    yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName(file.name)}"\r\nContent-Type: ${file.mime}\r\n\r\n`)
    for await (const part of file.source) { throwIfCancelled(signal); yield part }
    throwIfCancelled(signal)
    yield encoder.encode(`\r\n--${boundary}--\r\n`)
  })()
}
export function byteSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield bytes })()
}
function mediaSource(source: VendorMediaSource): AsyncIterable<Uint8Array> {
  if (source.bytes) return byteSource(source.bytes)
  if (source.stream) return source.stream()
  throw new ProviderError('input_rejected')
}

export async function uploadMiniMaxVideo(source: VendorMediaSource, config: ProviderConfig, dependencies: ProviderDriverDependencies, signal: AbortSignal, purpose = 'video_understanding'): Promise<string | null> {
  throwIfCancelled(signal)
  if (!config.api_key?.trim() || !config.base_url?.trim()) return null
  const apiKey = checkedKey(config.api_key)
  let url: URL
  try { url = new URL(config.base_url) } catch { throw new ProviderError('input_rejected') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new ProviderError('input_rejected')
  const boundary = `gugu_${crypto.randomUUID().replace(/-/g, '')}`
  let read = 0
  const bounded = (async function* () {
    for await (const chunk of mediaSource(source)) {
      throwIfCancelled(signal); read += chunk.byteLength
      if (read > source.size || read > 512_000_000) throw new ProviderError('input_rejected')
      yield chunk
    }
    if (read !== source.size) throw new ProviderError('input_rejected')
  })()
  try {
    const data = await requestJson(dependencies, {
      url: `${url.origin}/v1/files/upload`, method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, timeoutMs: 180_000,
      body: multipartBody({ purpose }, { name: source.name, mime: source.mime || 'application/octet-stream', source: bounded }, boundary, signal),
    }, signal)
    const fileId = record(data.file).file_id
    return typeof fileId === 'string' && fileId ? fileId : typeof fileId === 'number' && Number.isFinite(fileId) ? String(fileId) : null
  } catch (error) {
    throwIfCancelled(signal)
    observe(() => dependencies.diagnose?.('minimax_media_upload_failed', error))
    return null
  }
}

export type PreparedMiniMaxVideo = { readonly mode: 'base64'; readonly mime: string; readonly data: string }
  | { readonly mode: 'file'; readonly mime: string; readonly fileId: string; readonly uri: string }

export async function prepareMiniMaxVideo(source: VendorMediaSource, config: ProviderConfig, dependencies: VendorMediaDependencies, signal: AbortSignal): Promise<PreparedMiniMaxVideo> {
  throwIfCancelled(signal)
  if (!minimaxSupportsVideo(config.model)) throw new ProviderError('unsupported')
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > 512_000_000) throw new VendorMediaError('video_size_limit')
  if (!(MINIMAX_M3_MEDIA_LIMITS.video_mimes as readonly string[]).includes(source.mime)) throw new ProviderError('unsupported')
  let duration = source.duration
  if (duration === undefined) duration = (await dependencies.probeVideo?.(source, signal))?.duration ?? undefined
  throwIfCancelled(signal)
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new VendorMediaError('video_duration_unknown')
  if (duration > 1800) throw new VendorMediaError('video_duration_limit')
  if (source.size > 4 * 1024 * 1024) {
    const fileId = await uploadMiniMaxVideo(source, config, dependencies, signal)
    if (!fileId) throw new ProviderError('upstream')
    return { mode: 'file', mime: source.mime, fileId, uri: `mm_file://${fileId}` }
  }
  const parts: Uint8Array[] = []; let length = 0
  for await (const part of mediaSource(source)) {
    throwIfCancelled(signal); length += part.byteLength
    if (length > source.size || length > 4 * 1024 * 1024) throw new ProviderError('input_rejected')
    parts.push(part)
  }
  if (length !== source.size) throw new ProviderError('input_rejected')
  const bytes = new Uint8Array(length); let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  // btoa用于字节编码，不引入Node Buffer或本地文件依赖。
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return { mode: 'base64', mime: source.mime, data: btoa(binary) }
}

export function validateVendorImage(size: number, mime: string, limits: MediaLimits): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new ProviderError('input_rejected')
  if (typeof limits.image_max_bytes === 'number' && size > limits.image_max_bytes) throw new VendorMediaError('image_size_limit')
  if (Array.isArray(limits.image_mimes) && limits.image_mimes.length && !limits.image_mimes.includes(mime)) throw new ProviderError('unsupported')
}

/** 供协议构建器显式查看，不在Provider层转码或暗中降级媒体。 */
export function vendorMediaCapabilities(config: ProviderConfig): JsonObject {
  if (config.provider === 'mimo') return { audio_native_exts: [...MIMO_AUDIO_NATIVE_EXTS], supports_audio: true, supports_video: true }
  return { supports_image: minimaxSupportsImage(config.model), supports_video: minimaxSupportsVideo(config.model) }
}
