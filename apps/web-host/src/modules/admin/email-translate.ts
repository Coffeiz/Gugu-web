import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { EmailTranslationDraft } from '@gugu/core/email/translate'
import { translateEmailDraft } from '@gugu/core/email/translate'
import { completeStandaloneText } from '@gugu/core/providers'
import type { ProviderConfig, ProviderDriverDependencies, ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { createHash } from 'node:crypto'
import { readConfigOverride } from '../../adapters/config-override-file.js'
import { draft as validDraft, object } from './email-preview.js'

export interface AdminEmailTranslateOptions {
  readonly requireAdmin: preHandlerHookHandler
  translate(draft: EmailTranslationDraft): Promise<Awaited<ReturnType<typeof translateEmailDraft>>>
}

/** 只读旧版 ai 配置与 AI__ 环境覆盖，凭据不进入请求体、日志或返回值。 */
export function createAdminEmailTranslator(environment: NodeJS.ProcessEnv, configPath: string, createTransport?: () => ProviderTransport) {
  return async (draft: EmailTranslationDraft) => {
    const rawSettings = readConfigOverride(configPath).ai
    const values = object(rawSettings) ? rawSettings : {}
    const setting = (key: string, envKey: string, fallback: string) => environment[envKey] ?? String(values[key] ?? fallback)
    const config: ProviderConfig = {
      provider: setting('provider', 'AI__PROVIDER', 'qwen'),
      model: setting('model', 'AI__MODEL', 'qwen-max'),
      api_key: setting('api_key', 'AI__API_KEY', ''),
      base_url: setting('base_url', 'AI__BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      api_format: setting('api_format', 'AI__API_FORMAT', ''),
      thinking: setting('thinking', 'AI__THINKING', ''),
      reasoning_effort: setting('reasoning_effort', 'AI__REASONING_EFFORT', ''),
      ollama_api_mode: setting('ollama_api_mode', 'AI__OLLAMA_API_MODE', 'native'),
      ollama_mode: setting('ollama_mode', 'AI__OLLAMA_MODE', 'local'),
      timeout_ms: 300_000,
      capability_overrides: object(values.capability_overrides) ? values.capability_overrides as Record<string, boolean> : {},
    }
    const providerTransport = createTransport?.() ?? createNodeProviderTransport({ allowLocal: true, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => environment })
    const dependencies: ProviderDriverDependencies = {
      transport: providerTransport,
      digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    }
    try {
      return await translateEmailDraft(draft, (prompt, maxTokens) => completeStandaloneText({
        config, prompt, maxTokens, signal: new AbortController().signal,
        identity: { ownerId: 'admin-email', sessionId: 'translation', runId: 'email-translation' },
      }, dependencies))
    } finally { await providerTransport.close?.() }
  }
}

/** Host 处理管理员认证与旧 DTO 边界；邮件结构规则和模型输出校验位于 Core。 */
export function registerAdminEmailTranslateRoute(app: FastifyInstance, options: AdminEmailTranslateOptions): void {
  app.post('/api/v1/admin/email/translate', { preHandler: options.requireAdmin }, async (request, reply) => {
    if (!validDraft(request.body)) return reply.code(422).send({ detail: '邮件草稿参数无效' })
    const value = request.body as unknown as Record<string, unknown>
    const draft = {
      ...value,
      preheader: value.preheader ?? '',
      sections: value.sections ?? [],
      actions: value.actions ?? [],
      template: value.template ?? 'notification',
      theme: value.theme ?? 'light',
      palette: value.palette ?? 'neutral',
    } as EmailTranslationDraft
    try { return { translations: await options.translate(draft) } }
    catch { return reply.code(502).send({ detail: '多语言邮件生成失败，请检查当前模型配置' }) }
  })
}
