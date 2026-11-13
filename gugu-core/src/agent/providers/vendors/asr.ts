import { observe } from '../values.js'
import { throwIfCancelled } from '../errors.js'
import type { JsonObject, ProviderConfig, ProviderDriverDependencies } from '../contracts.js'
import { classifyProviderError, ProviderError } from '../errors.js'
import { endpoint, requestJson } from '../http.js'
import { record } from '../values.js'
import { adapterFor } from '../registry.js'
import { normalizedApiKey } from '../diagnostics.js'
import { retryClock } from '../retry.js'
import { byteSource, multipartBody, VendorMediaError } from './media.js'

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
export interface AsrMedia {
  readonly type: string
  readonly raw?: Uint8Array
  readonly b64?: string
  readonly mime?: string
  readonly ext?: string
  readonly duration?: number
}
export interface AsrDependencies extends ProviderDriverDependencies {
  probeAudioDuration(raw: Uint8Array, extension: string | undefined, signal: AbortSignal): Promise<number | null>
  toWav(raw: Uint8Array, signal: AbortSignal): Promise<Uint8Array | null>
}

/** 已授权音频的转码端口；不接触路径、预设、凭据存储或语音业务路由。 */
export interface CompatibleAsrDependencies extends ProviderDriverDependencies {
  toWav(raw: Uint8Array, signal: AbortSignal): Promise<Uint8Array | null>
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>
}

const compatibleMimeTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'])
const dashscopeServices = new Set(['qwen3-asr', 'qwen-audio', 'fun-asr'])
const dashscopeSuffix = '/api/v1/services/aigc/multimodal-generation/generation'

/** 原生地址必须完整填写；保留地域、Workspace前缀和非凭据query，不自动补路径。 */
export function dashscopeAsrEndpoint(baseUrl: string | undefined): string {
  let url: URL
  try { url = new URL(baseUrl?.trim() || '') } catch { throw new ProviderError('input_rejected') }
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.pathname.endsWith(dashscopeSuffix))
    throw new ProviderError('input_rejected')
  if ([...url.searchParams.keys()].some(name => /^(?:api[_-]?key|x-api-key|key|token|access[_-]?token|secret|authorization|auth)$/i.test(name)))
    throw new ProviderError('input_rejected')
  url.hash = ''
  return url.toString()
}

/** 百炼三条产品线的已有响应形状；空识别结果保持空串。 */
export function dashscopeAsrTranscript(payload: Record<string, unknown>): string {
  const output = record(payload.output)
  if (typeof output.text === 'string') return output.text.trim()
  const sentence = record(output.sentence)
  if (typeof sentence.text === 'string') return sentence.text.trim()
  const choices = Array.isArray(output.choices) ? output.choices : []
  const content = record(record(choices[0]).message).content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map(item => {
    const value = record(item).text
    return typeof value === 'string' || typeof value === 'number' ? String(value || '') : ''
  }).join('').trim()
  return ''
}

function encodeBase64(raw: Uint8Array): string {
  let value = ''
  for (let index = 0; index < raw.byteLength; index += 32_768)
    value += String.fromCharCode(...raw.subarray(index, index + 32_768))
  return btoa(value)
}

/** 纯ASR只发送音频，不复用聊天thinking、生成参数或当前主模型的配置。 */
export async function transcribeCompatibleAsr(media: readonly AsrMedia[], config: ProviderConfig, dependencies: CompatibleAsrDependencies, signal: AbortSignal, options: { readonly raiseErrors?: boolean } = {}): Promise<string> {
  throwIfCancelled(signal)
  const format = config.api_format?.trim().toLowerCase() || 'openai'
  if (!['openai', 'dashscope'].includes(format)) throw new ProviderError('unsupported')
  if (!config.model.trim()) throw new ProviderError('input_rejected')
  const serviceValue = config.dashscope_service
  const service = serviceValue == null || serviceValue === '' ? 'qwen3-asr'
    : typeof serviceValue === 'string' ? serviceValue.trim().toLowerCase() : ''
  if (format === 'dashscope' && !dashscopeServices.has(service)) throw new ProviderError('unsupported')
  const parts: JsonObject[] = []
  for (const item of media) {
    throwIfCancelled(signal)
    if (item.type !== 'audio' || item.raw === undefined && !item.b64) continue
    let raw = item.b64 ? decodeBase64(item.b64) : item.raw!.slice()
    let mime = (item.mime || 'audio/mpeg').toLowerCase()
    if (!compatibleMimeTypes.has(mime)) {
      let converted: Uint8Array | null
      try { converted = await dependencies.toWav(raw, signal) }
      catch (cause) {
        throwIfCancelled(signal)
        observe(() => dependencies.diagnose?.('compatible_asr_conversion_failed', cause))
        if (options.raiseErrors) throw classifyProviderError(cause)
        continue
      }
      throwIfCancelled(signal)
      if (!converted) continue
      raw = converted; mime = 'audio/wav'
    }
    parts.push({ type: 'input_audio', input_audio: { data: `data:${mime};base64,${encodeBase64(raw)}` } })
  }
  if (!parts.length) return ''
  // 仅复用目的地和认证规则，不能调用聊天driver构造器引入thinking或工具参数。
  const compatible = { ...config, api_format: 'openai' }, policy = adapterFor(compatible)
  const key = normalizedApiKey(format === 'dashscope' ? config.api_key : config.api_key || (policy.name === 'ollama' ? 'ollama' : 'dummy'))
  const url = format === 'dashscope' ? dashscopeAsrEndpoint(config.base_url) : endpoint(policy.baseUrl(compatible), 'chat/completions')
  const body: JsonObject = format === 'dashscope' ? {
    model: config.model,
    input: { messages: [{ role: 'user', content: service === 'qwen3-asr' ? parts.map(part => ({ audio: record(part.input_audio).data as string })) : parts }] },
    parameters: service === 'qwen3-asr' ? { asr_options: { enable_itn: false } } : { format: 'wav', sample_rate: 16000 },
  } : { model: config.model, messages: [{ role: 'user', content: parts }], asr_options: { enable_itn: false } }
  const headers = { ...(format === 'openai' ? policy.headers(compatible) : {}), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(format === 'dashscope' ? { 'X-DashScope-SSE': 'disable' } : {}) }
  const provider = config.provider?.trim().toLowerCase()
  for (let attempt = 0; ; attempt++) {
    try {
      throwIfCancelled(signal)
      const payload = await requestJson(dependencies, { url, method: 'POST', headers, body, timeoutMs: config.timeout_ms, allowLocal: provider === 'local' || provider === 'ollama' }, signal)
      if (format === 'dashscope') return dashscopeAsrTranscript(payload)
      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const message = record(record(choices[0]).message)
      if (!choices.length || !Object.keys(message).length) throw new ProviderError('protocol')
      if (message.content == null) return ''
      if (typeof message.content !== 'string') throw new ProviderError('protocol')
      return message.content.trim()
    } catch (cause) {
      throwIfCancelled(signal)
      const error = classifyProviderError(cause)
      observe(() => dependencies.diagnose?.('compatible_asr_failed', cause))
      const status = error.options.status
      const transient = status === 429 || status !== undefined && status >= 500 && status <= 599
        || status === undefined && ['network', 'timeout'].includes(error.code) && error.options.retryable === true
      if (attempt < 2 && transient) {
        try { await (dependencies.sleep ?? retryClock.sleep)((attempt + 1) * 1000, signal) }
        catch (cause) {
          throwIfCancelled(signal)
          observe(() => dependencies.diagnose?.('compatible_asr_backoff_failed', cause))
          if (options.raiseErrors) throw classifyProviderError(cause)
          return ''
        }
        throwIfCancelled(signal)
        continue
      }
      if (options.raiseErrors) throw error
      return ''
    }
  }
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
function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new VendorMediaError('invalid_encoding')
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) } catch { throw new VendorMediaError('invalid_encoding') }
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
    let raw = item.raw || decodeBase64(item.b64!)
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
