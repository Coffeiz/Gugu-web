import { createHash } from 'node:crypto'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { z } from 'zod'

import { deepResearchProbe,similarImageProbe } from '@gugu/core/providers'

import type { ProviderTransport } from '@gugu/core/providers'

import { createNodeProviderTransport } from '@gugu/core/providers/node'

import { redactToolError } from '@gugu/core/agent'

import { readConfigOverride } from '../../adapters/config/config-override-file.js'

const requestSchema = z.object({
  target: z.enum(['tavily', 'deep_research', 'baidu_similar_images']),
  tavily_api_key: z.string().max(4096).optional().default(''),
  baidu_qianfan_api_key: z.string().max(4096).optional().default(''),
  deep_research_provider: z.string().max(32).optional().default(''),
  deep_research_baidu_api_key: z.string().max(4096).optional().default(''),
  deep_research_you_api_key: z.string().max(4096).optional().default(''),
})

export interface AdminSearchTestOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly test: ReturnType<typeof createAdminSearchTest>
}

export interface AdminSearchProbeOptions {
  readonly createTransport?: () => ProviderTransport & { close?(): Promise<void> }
}

const similarImageProbePng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlklEQVR4nO3QMQ0AMAzAsPLHWC4rDB/L4T/K7O772egArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0A6OSM1jeqEVYAAAAAElFTkSuQmCC'

export function createAdminSearchProbe(environment: NodeJS.ProcessEnv, options: AdminSearchProbeOptions = {}) {
  return async (input: { target: AdminSearchTestInput['target']; provider: string; api_key: string }): Promise<AdminSearchTestProbeResult> => {
    const transport = options.createTransport?.() ?? createNodeProviderTransport({ connectTimeoutMs: 10_000, environment: () => environment })
    const dependencies = {
      transport,
      digest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    }
    try {
      if (input.target === 'baidu_similar_images') {
        const result = await similarImageProbe(input.api_key, Buffer.from(similarImageProbePng, 'base64'), 1, dependencies, AbortSignal.timeout(30_000))
        return { ok: !result.error_code }
      }
      const result = await deepResearchProbe(input.provider, input.api_key,
        input.target === 'tavily' ? 'test' : '测试深度研究连接', 1, 'basic', dependencies, AbortSignal.timeout(60_000))
      const results = Array.isArray(result.results) ? result.results : []
      return {
        ok: !result.error,
        ...(typeof result.error === 'string' ? { error: result.error } : {}),
        has_results: Boolean(result.answer) || results.length > 0,
      }
    } catch (error) {
      const message = error instanceof Error
        ? redactToolError(error.message).replaceAll(input.api_key, '‹密钥已隐藏›').replace(/https?:\/\/[^\s'"<>]+/gi, '‹地址已隐藏›').slice(0, 90)
        : '请求失败'
      return { ok: false, error: message }
    } finally { await transport.close?.() }
  }
}

export function createAdminSearchTestOperations(path: string | null, environment: NodeJS.ProcessEnv) {
  return createAdminSearchTest({
    readSettings: () => adminSearchTestSettings(path ? readConfigOverride(path) : {}, environment),
    probe: createAdminSearchProbe(environment),
  })
}

export function registerAdminSearchTestRoute(app: FastifyInstance, options: AdminSearchTestOptions): void {
  app.post('/api/v1/admin/config/test-search', { preHandler: options.requireAdmin }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '搜索测试参数无效' })
    return options.test(parsed.data)
  })
}

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
