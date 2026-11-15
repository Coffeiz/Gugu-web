export type AdminSearchTestTarget = 'tavily' | 'deep_research' | 'baidu_similar_images'

export interface AdminSearchTestInput {
  readonly target: AdminSearchTestTarget
  readonly tavily_api_key?: string
  readonly baidu_qianfan_api_key?: string
  readonly deep_research_provider?: string
  readonly deep_research_baidu_api_key?: string
  readonly deep_research_you_api_key?: string
}

export interface AdminSearchTestSettings {
  readonly tavily_api_key?: string
  readonly baidu_qianfan_api_key?: string
  readonly deep_research_provider?: string
  readonly deep_research_baidu_api_key?: string
  readonly deep_research_you_api_key?: string
}

export interface AdminSearchTestProbeResult {
  readonly ok: boolean
  readonly has_results?: boolean
  readonly error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string { return typeof value === 'string' ? value : '' }

/** Python `config.test_search` 的配置回退、结果检查与响应文案。 */
export function createAdminSearchTest(dependencies: {
  readSettings(): AdminSearchTestSettings
  probe(input: { readonly target: AdminSearchTestTarget; readonly provider: string; readonly api_key: string }): Promise<AdminSearchTestProbeResult>
}) {
  return async (input: AdminSearchTestInput): Promise<{ readonly ok: boolean; readonly message: string }> => {
    const settings = dependencies.readSettings()
    const provider = input.target === 'deep_research'
      ? input.deep_research_provider || settings.deep_research_provider || ''
      : input.target === 'tavily' ? 'tavily' : 'baidu'
    const api_key = input.target === 'deep_research'
      ? provider === 'tavily' ? input.tavily_api_key || settings.tavily_api_key || ''
        : provider === 'baidu' ? input.deep_research_baidu_api_key || settings.deep_research_baidu_api_key || ''
          : provider === 'you' ? input.deep_research_you_api_key || settings.deep_research_you_api_key || '' : ''
      : input.target === 'tavily' ? input.tavily_api_key || settings.tavily_api_key || ''
        : input.baidu_qianfan_api_key || settings.baidu_qianfan_api_key || ''

    if (!api_key) {
      if (input.target === 'deep_research') return { ok: false, message: `未配置 ${provider} 深度研究 API Key` }
      return { ok: false, message: input.target === 'tavily' ? '未配 Tavily API Key' : '未配置百度千帆 API Key' }
    }
    try {
      const result = await dependencies.probe({ target: input.target, provider, api_key })
      if (!result.ok) {
        if (input.target === 'deep_research') return { ok: false, message: `${provider} Key 无效或请求失败：${result.error || '请求失败'}` }
        if (input.target === 'tavily') return { ok: false, message: `Key 无效或请求失败：${result.error || '请求失败'}` }
        return { ok: false, message: '百度相似图搜索测试失败，请查看受限诊断日志' }
      }
      if (input.target === 'deep_research' && !result.has_results)
        return { ok: false, message: `${provider} 已连通但没有返回研究结果` }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 90) : '请求失败'
      if (input.target === 'deep_research') return { ok: false, message: `${provider} Key 无效或请求失败：${detail}` }
      if (input.target === 'tavily') return { ok: false, message: `Key 无效或请求失败：${detail}` }
      return { ok: false, message: '百度相似图搜索测试失败，请查看受限诊断日志' }
    }
    if (input.target === 'deep_research') return { ok: true, message: `OK — ${provider} 深度研究连接正常（本次测试可能消耗 1 次调用）` }
    if (input.target === 'tavily') return { ok: true, message: 'OK — Tavily Key 有效（本次测试消耗 1 次调用）' }
    return { ok: true, message: '百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）' }
  }
}

/** 从运行时 JSON 配置中读取搜索凭据，避免 Host 和 Core 重复配置字段映射。 */
export function adminSearchTestSettings(document: unknown, environment: Readonly<Record<string, string | undefined>> = {}): AdminSearchTestSettings {
  const search = record(record(document)?.search)
  const value = (key: keyof AdminSearchTestSettings, envName: string) =>
    string(search && Object.hasOwn(search, key) ? search[key] : environment[envName])
  return {
    tavily_api_key: value('tavily_api_key', 'SEARCH__TAVILY_API_KEY'),
    baidu_qianfan_api_key: value('baidu_qianfan_api_key', 'SEARCH__BAIDU_QIANFAN_API_KEY'),
    deep_research_provider: value('deep_research_provider', 'SEARCH__DEEP_RESEARCH_PROVIDER'),
    deep_research_baidu_api_key: value('deep_research_baidu_api_key', 'SEARCH__DEEP_RESEARCH_BAIDU_API_KEY'),
    deep_research_you_api_key: value('deep_research_you_api_key', 'SEARCH__DEEP_RESEARCH_YOU_API_KEY'),
  }
}
