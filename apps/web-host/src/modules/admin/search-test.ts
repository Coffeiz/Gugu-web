import { createHash } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { adminSearchTestSettings, createAdminSearchTest } from '@gugu/core/admin/search-test'
import type { AdminSearchTestInput, AdminSearchTestProbeResult } from '@gugu/core/admin/search-test'
import { deepResearchProbe, similarImageProbe } from '@gugu/core/providers'
import type { ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { redactToolError } from '@gugu/core/agent'
import { readConfigOverride } from '../../adapters/config-override-file.js'

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
