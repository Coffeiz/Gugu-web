/** Provider 原生搜索开关可见性；实际可用性由服务端配置与凭据校验决定。 */
export function providerWebSearchAvailable(draft: {
  provider: string; api_format?: unknown; model?: unknown; base_url?: unknown; ollama_mode?: unknown
}): boolean {
  if (['minimax', 'glm', 'deepseek'].includes(draft.provider)) return true
  if (draft.provider === 'qwen') return ['', 'openai', 'responses'].includes(String(draft.api_format || ''))
  if (draft.provider === 'mimo') {
    return ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'].includes(String(draft.model || '').trim().toLowerCase())
  }
  if (draft.provider === 'ollama') {
    const baseUrl = String(draft.base_url || '').trim()
    if (!baseUrl) return draft.ollama_mode === 'cloud'
    try {
      const url = new URL(baseUrl)
      return url.protocol === 'https:' && url.hostname === 'ollama.com' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443')
    } catch { return false }
  }
  return false
}
