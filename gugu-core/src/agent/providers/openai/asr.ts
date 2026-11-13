import { ProviderError, throwIfCancelled } from '../errors.js'
import type { ProviderConfig } from '../contracts.js'
import { endpoint, requestJson } from '../http.js'
import { adapterFor } from '../registry.js'
import { normalizedApiKey } from '../diagnostics.js'
import { observe, record } from '../values.js'
import { prepareCompatibleAudioParts, requestCompatibleAsr, type AsrMedia, type CompatibleAsrDependencies } from '../asr/shared.js'

/** OpenAI-compatible ASR；仅组装转写请求，不复用聊天生成参数或 tools。 */
export async function transcribeOpenAiAsr(
  media: readonly AsrMedia[], config: ProviderConfig, dependencies: CompatibleAsrDependencies,
  signal: AbortSignal, options: { readonly raiseErrors?: boolean } = {},
): Promise<string> {
  throwIfCancelled(signal)
  if (!config.model.trim()) throw new ProviderError('input_rejected')
  if (config.api_format?.trim().toLowerCase() && config.api_format.trim().toLowerCase() !== 'openai')
    throw new ProviderError('unsupported')
  const parts = await prepareCompatibleAudioParts(media, dependencies, signal, cause => {
    observe(() => dependencies.diagnose?.('compatible_asr_conversion_failed', cause))
    if (options.raiseErrors) throw classifyProviderError(cause)
  })
  if (!parts.length) return ''

  const compatible = { ...config, api_format: 'openai' }
  const policy = adapterFor(compatible)
  const key = normalizedApiKey(config.api_key || (policy.name === 'ollama' ? 'ollama' : 'dummy'))
  const url = endpoint(policy.baseUrl(compatible), 'chat/completions')
  const body = { model: config.model, messages: [{ role: 'user', content: parts }], asr_options: { enable_itn: false } }
  const headers = { ...policy.headers(compatible), Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const provider = config.provider?.trim().toLowerCase()
  return requestCompatibleAsr(dependencies, signal, options, () => requestJson(dependencies, {
    url, method: 'POST', headers, body, timeoutMs: config.timeout_ms,
    allowLocal: provider === 'local' || provider === 'ollama',
  }, signal), payload => {
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const message = record(record(choices[0]).message)
    if (!choices.length || !Object.keys(message).length) throw new ProviderError('protocol')
    if (message.content == null) return ''
    if (typeof message.content !== 'string') throw new ProviderError('protocol')
    return message.content.trim()
  })
}
