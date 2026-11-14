import { observe, record } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { ProviderConfig } from '../contracts.js'
import { ProviderError } from '../errors.js'
import { requestJson } from '../http.js'
import { byteSource, multipartBody, VendorMediaError } from '../media.js'
import { decodeAsrBase64, type AsrDependencies, type AsrMedia } from '../asr/shared.js'

export const MINIMAX_ASR_MAX_FILE_BYTES = 50 * 1024 * 1024
export const MINIMAX_ASR_MAX_DURATION_SECONDS = 500
const formats: Readonly<Record<string, readonly [string, string]>> = {
  wav: ['wav', 'audio/wav'], aiff: ['aiff', 'audio/aiff'], aif: ['aif', 'audio/aiff'], flac: ['flac', 'audio/flac'],
  m4a: ['m4a', 'audio/mp4'], mp3: ['mp3', 'audio/mpeg'], aac: ['aac', 'audio/aac'], opus: ['opus', 'audio/opus'], ogg: ['ogg', 'audio/ogg'],
}
const mimeExtensions: Readonly<Record<string, string>> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'aac', 'audio/opus': 'opus', 'audio/ogg': 'ogg', 'application/ogg': 'ogg',
}

export function minimaxAsrEndpoint(baseUrl: string | undefined): string {
  let url: URL
  try { url = new URL(baseUrl?.trim() || 'https://api.minimax.cn') } catch { throw new ProviderError('input_rejected') }
  if (url.protocol !== 'https:' || url.hostname !== 'api.minimax.cn' || url.port && url.port !== '443' || url.username || url.password || url.search || url.hash || !['', '/v1', '/v1/speech_to_text'].includes(url.pathname.replace(/\/+$/, ''))) throw new ProviderError('input_rejected')
  return 'https://api.minimax.cn/v1/speech_to_text'
}
export function minimaxAudioFormat(item: Pick<AsrMedia, 'ext'>, mime: string): readonly [string, string] | null {
  const ext = (item.ext || '').toLowerCase().replace(/^\./, '') || mimeExtensions[mime] || ''
  return formats[ext] || null
}

/** 独立ASR只转写授权输入；duration探测/转码由媒体Adapter注入。 */
export async function transcribeMiniMax(media: readonly AsrMedia[], config: ProviderConfig, dependencies: AsrDependencies, signal: AbortSignal, options: { readonly raiseErrors?: boolean } = {}): Promise<string> {
  throwIfCancelled(signal)
  if ((config.model.trim() || 'asr-1.0') !== 'asr-1.0') throw new ProviderError('unsupported')
  const url = minimaxAsrEndpoint(config.base_url), key = config.api_key?.trim() || ''
  if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new ProviderError('authentication')
  const transcripts: string[] = []
  for (const item of media) {
    throwIfCancelled(signal)
    if (item.type !== 'audio' || !item.raw && !item.b64) continue
    let raw = item.raw || decodeAsrBase64(item.b64!)
    if (raw.byteLength > MINIMAX_ASR_MAX_FILE_BYTES) throw new VendorMediaError('asr_size_limit')
    const mime = (item.mime || 'application/octet-stream').split(';')[0]!.toLowerCase()
    if (['audio/pcm', 'audio/l16', 'audio/x-pcm'].includes(mime)) throw new VendorMediaError('asr_pcm')
    const formatted = minimaxAudioFormat(item, mime)
    const sourceExt = (item.ext || formatted?.[0] || '').toLowerCase().replace(/^\./, '') || undefined
    const duration = typeof item.duration === 'number' ? item.duration : await dependencies.probeAudioDuration(raw, sourceExt, signal)
    throwIfCancelled(signal)
    if (duration == null || !Number.isFinite(duration) || duration <= 0) throw new VendorMediaError('asr_duration_unknown')
    if (duration > MINIMAX_ASR_MAX_DURATION_SECONDS) throw new VendorMediaError('asr_duration_limit')
    let ext: string, uploadMime: string
    if (formatted) [ext, uploadMime] = formatted
    else {
      const converted = await dependencies.toWav(raw, signal)
      throwIfCancelled(signal)
      if (!converted) throw new VendorMediaError('asr_conversion')
      raw = converted; ext = 'wav'; uploadMime = 'audio/wav'
    }
    if (raw.byteLength > MINIMAX_ASR_MAX_FILE_BYTES) throw new VendorMediaError('asr_size_limit')
    const boundary = `gugu_asr_${crypto.randomUUID().replace(/-/g, '')}`
    try {
      const payload = await requestJson(dependencies, {
        url, method: 'POST', timeoutMs: config.timeout_ms,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: multipartBody({ model: config.model || 'asr-1.0', response_format: 'json', stream: 'false' }, { name: `audio.${ext}`, mime: uploadMime, source: byteSource(raw) }, boundary, signal),
      }, signal)
      const base = record(payload.base_resp)
      if (base.status_code != null && !['', '0'].includes(String(base.status_code))) throw new ProviderError('upstream')
      if (typeof payload.text !== 'string') throw new ProviderError('protocol')
      transcripts.push(payload.text.trim())
    } catch (error) {
      throwIfCancelled(signal)
      observe(() => dependencies.diagnose?.('minimax_asr_failed', error))
      if (options.raiseErrors) throw error
      return ''
    }
  }
  return transcripts.filter(Boolean).join('\n')
}
