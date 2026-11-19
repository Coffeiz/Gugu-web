import type { ByokCredential } from '../../byok/store.js'

/** 缺少用户目的地时沿用平台配置，但绝不把用户密钥与平台地址拼接。 */
function resolveByokLlmWithValue<T extends Record<string, unknown>>(base: T, row: ByokCredential | null, apiKey: string, defaultBaseUrl: (provider: string, format: string) => string, strict = false): T {
  if (!row) return base
  const url = (row.base_url.trim() || defaultBaseUrl(row.provider, row.api_format).trim()).replace(/\/+$/, '')
  if (strict && (!url || !apiKey.trim() || !row.model.trim())) throw new Error('LLM 凭据配置不完整')
  if (!url) return base
  return { ...base, provider: row.provider, api_format: row.api_format, api_key: apiKey, base_url: url,
    model: row.model || base.model, image: row.image, video: row.video, audio: row.audio, image_detail: row.image_detail, is_byok: true, web_search_enabled: row.web_search_enabled,
    ollama_api_mode: row.provider === 'ollama' && ['', 'native'].includes(row.api_format) ? 'native' : 'openai',
    ...(row.max_tokens == null ? {} : { max_tokens: row.max_tokens }), ...(row.context_tokens == null ? {} : { context_tokens: row.context_tokens }),
    thinking: row.thinking, reasoning_effort: row.reasoning_effort || '', reasoning_persistence: row.reasoning_persistence }
}

export function resolveByokLlm<T extends Record<string, unknown>>(base: T, row: ByokCredential | null, decryptValue: (row: ByokCredential) => string, defaultBaseUrl: (provider: string, format: string) => string, strict = false): T {
  return resolveByokLlmWithValue(base, row, row ? decryptValue(row) : '', defaultBaseUrl, strict)
}

/** Host 文件密钥解封需要异步 I/O；与同步解析器采用同一目的地绑定和字段覆盖规则。 */
export async function resolveByokLlmAsync<T extends Record<string, unknown>>(base: T, row: ByokCredential | null, decryptValue: (row: ByokCredential) => Promise<string>, defaultBaseUrl: (provider: string, format: string) => string): Promise<T> {
  return resolveByokLlmWithValue(base, row, row ? await decryptValue(row) : '', defaultBaseUrl)
}
