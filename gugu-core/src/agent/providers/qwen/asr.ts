import { ProviderError, throwIfCancelled } from '../errors.js'
import type { JsonObject, ProviderConfig } from '../contracts.js'
import { requestJson } from '../http.js'
import { normalizedApiKey } from '../diagnostics.js'
import { observe, record } from '../values.js'
import { prepareCompatibleAudioParts, requestCompatibleAsr, type AsrMedia, type CompatibleAsrDependencies } from '../asr/shared.js'

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

/** 百炼原生 ASR；协议形态和服务选择均属于 Qwen/百炼适配器。 */
export async function transcribeDashscopeAsr(
  media: readonly AsrMedia[], config: ProviderConfig, dependencies: CompatibleAsrDependencies,
  signal: AbortSignal, options: { readonly raiseErrors?: boolean } = {},
): Promise<string> {
  throwIfCancelled(signal)
  if (!config.model.trim()) throw new ProviderError('input_rejected')
  const serviceValue = config.dashscope_service
  const service = serviceValue == null || serviceValue === '' ? 'qwen3-asr'
    : typeof serviceValue === 'string' ? serviceValue.trim().toLowerCase() : ''
  if (!dashscopeServices.has(service)) throw new ProviderError('unsupported')
  const parts = await prepareCompatibleAudioParts(media, dependencies, signal, cause => {
    observe(() => dependencies.diagnose?.('compatible_asr_conversion_failed', cause))
    if (options.raiseErrors) throw classifyProviderError(cause)
  })
  if (!parts.length) return ''

  const key = normalizedApiKey(config.api_key)
  const body: JsonObject = {
    model: config.model,
    input: { messages: [{ role: 'user', content: service === 'qwen3-asr'
      ? parts.map(part => ({ audio: record(part.input_audio).data as string }))
      : parts } ] },
    parameters: service === 'qwen3-asr' ? { asr_options: { enable_itn: false } } : { format: 'wav', sample_rate: 16000 },
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' }
  return requestCompatibleAsr(dependencies, signal, options, () => requestJson(dependencies, {
    url: dashscopeAsrEndpoint(config.base_url), method: 'POST', headers, body,
    timeoutMs: config.timeout_ms,
  }, signal), dashscopeAsrTranscript)
}
