import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { MediaLimits, ProviderConfig, ProviderDriverDependencies } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { requestJson } from '../http.js'
import { record } from '../values.js'
import { DEFAULT_MEDIA_LIMITS, VendorMediaError, byteSource, multipartBody, type VendorMediaDependencies, type VendorMediaSource } from '../media.js'

export const MINIMAX_M3_MEDIA_LIMITS: MediaLimits = Object.freeze({
  ...DEFAULT_MEDIA_LIMITS, video_source_max_bytes: 512_000_000,
  max_duration_s: 1800, duration_limit_inclusive: false, max_size_bytes: 512_000_000,
  image_max_bytes: 10_000_000, image_mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  image_extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'], preserve_image_source: true,
  transcode_video: false, video_mimes: ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-matroska'],
  base64_max: 4 * 1024 * 1024, prefer_file_upload: true,
})
export const minimaxSupportsImage = (model: string) => model.toLowerCase().startsWith('minimax-m3')
export const minimaxSupportsVideo = (model: string) => model.toLowerCase().includes('m3')
export const minimaxMediaLimits = (model: string): MediaLimits => minimaxSupportsVideo(model) ? MINIMAX_M3_MEDIA_LIMITS : DEFAULT_MEDIA_LIMITS

function checkedKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !/^[\x21-\x7e]+$/.test(value.trim())) throw new ProviderError('authentication')
  return value.trim()
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
