import type { JsonObject, ProviderDriverDependencies } from '../contracts.js'
import { VendorMediaError } from '../media.js'
import { classifyProviderError, throwIfCancelled } from '../errors.js'
import { retryClock } from '../retry.js'
import { observe } from '../values.js'

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

export function encodeAsrBase64(raw: Uint8Array): string {
  let value = ''
  for (let index = 0; index < raw.byteLength; index += 32_768)
    value += String.fromCharCode(...raw.subarray(index, index + 32_768))
  return btoa(value)
}

export function decodeAsrBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new VendorMediaError('invalid_encoding')
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }
  catch { throw new VendorMediaError('invalid_encoding') }
}

/** 把已授权音频转换为兼容协议共用的输入片段。 */
export async function prepareCompatibleAudioParts(
  media: readonly AsrMedia[], dependencies: CompatibleAsrDependencies, signal: AbortSignal,
  onConversionError: (cause: unknown) => void,
): Promise<JsonObject[]> {
  const parts: JsonObject[] = []
  for (const item of media) {
    throwIfCancelled(signal)
    if (item.type !== 'audio' || item.raw === undefined && !item.b64) continue
    let raw = item.b64 ? decodeAsrBase64(item.b64) : item.raw!.slice()
    let mime = (item.mime || 'audio/mpeg').toLowerCase()
    if (!compatibleMimeTypes.has(mime)) {
      let converted: Uint8Array | null
      try { converted = await dependencies.toWav(raw, signal) }
      catch (cause) { throwIfCancelled(signal); onConversionError(cause); continue }
      throwIfCancelled(signal)
      if (!converted) continue
      raw = converted
      mime = 'audio/wav'
    }
    parts.push({ type: 'input_audio', input_audio: { data: `data:${mime};base64,${encodeAsrBase64(raw)}` } })
  }
  return parts
}

/** OpenAI-compatible与DashScope ASR 共用有限重试边界，Provider只提供请求/响应协议。 */
export async function requestCompatibleAsr<T>(
  dependencies: CompatibleAsrDependencies, signal: AbortSignal,
  options: { readonly raiseErrors?: boolean }, request: () => Promise<T>, parse: (payload: T) => string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      throwIfCancelled(signal)
      return parse(await request())
    } catch (cause) {
      throwIfCancelled(signal)
      const error = classifyProviderError(cause)
      observe(() => dependencies.diagnose?.('compatible_asr_failed', cause))
      const status = error.options.status
      const transient = status === 429 || status !== undefined && status >= 500 && status <= 599
        || status === undefined && ['network', 'timeout'].includes(error.code) && error.options.retryable === true
      if (attempt < 2 && transient) {
        try { await (dependencies.sleep ?? retryClock.sleep)((attempt + 1) * 1000, signal) }
        catch (sleepError) {
          throwIfCancelled(signal)
          observe(() => dependencies.diagnose?.('compatible_asr_backoff_failed', sleepError))
          if (options.raiseErrors) throw classifyProviderError(sleepError)
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
