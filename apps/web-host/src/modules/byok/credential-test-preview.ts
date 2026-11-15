import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { normalizedApiKey, providerDiagnosticRequest } from '@gugu/core/providers'
import type { ProviderHttpResponse } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { redactToolError } from '@gugu/core/agent'
import type { CredentialTestPreviewOptions, createCredentialSavedTest, createCredentialTestPreview } from '@gugu/core/byok/credential-test-preview'

const schema = z.object({
  provider: z.string().min(1).max(64),
  capability: z.enum(['deep_research', 'similar_image_search', 'embedding', 'llm', 'speech_to_text']),
  value: z.string().max(20_000).default(''),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  dimensions: z.number().int().min(0).max(65_536).nullable().optional(),
  credential_id: z.number().int().nullable().optional(),
})

export interface CredentialTestPreviewRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  preview: ReturnType<typeof createCredentialTestPreview>
  savedTest: ReturnType<typeof createCredentialSavedTest>
}

async function cancel(response: ProviderHttpResponse): Promise<void> { await response.cancel() }

async function responseText(response: ProviderHttpResponse, maxBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > maxBytes) return ''
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await cancel(response) }
}

function safeUpstreamMessage(body: string, apiKey: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    let message = typeof value.error?.message === 'string' ? value.error.message
      : typeof value.message === 'string' ? value.message : ''
    if (apiKey) message = message.replaceAll(apiKey, '‹密钥已隐藏›')
    return message ? redactToolError(message).replace(/https?:\/\/[^\s'"<>]+/gi, '‹地址已隐藏›').slice(0, 200) : ''
  } catch { return '' }
}

/** LLM/ASR OpenAI兼容诊断走生产 Provider transport；不跟随重定向或回显上游正文。 */
export function createByokCredentialTestProbe(environment: NodeJS.ProcessEnv) {
  return async (input: Parameters<CredentialTestPreviewOptions['probe']>[0]) => {
    if (input.capability === 'embedding') {
      let apiKey: string
      try { apiKey = normalizedApiKey(input.apiKey) }
      catch { return { ok: false, status: 0, detail: '', message: '无法连接 Embedding 服务，请检查 Base URL 与网络' } }
      const local = ['local', 'ollama'].includes(input.provider.trim().toLowerCase())
      const transport = createNodeProviderTransport({ allowLocal: local, connectTimeoutMs: 10_000, environment: () => environment })
      try {
        const response = await transport.request({
          url: `${input.baseUrl.replace(/\/+$/, '')}/embeddings`, method: 'POST', timeoutMs: 10_000, allowLocal: local,
          headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: { model: input.model, input: 'ping', ...(input.dimensions ? { dimensions: input.dimensions } : {}) },
        }, AbortSignal.timeout(10_000))
        const status = response.status
        const body = await responseText(response)
        if (status !== 200) {
          const detail = safeUpstreamMessage(body.trim().slice(0, 200), apiKey)
          return { ok: false, status, detail: '', message: `Embedding 测试失败（HTTP ${status}）${detail ? `：${detail}` : ''}` }
        }
        let vector: unknown
        try { vector = (JSON.parse(body) as { data?: Array<{ embedding?: unknown }> }).data?.[0]?.embedding }
        catch { vector = undefined }
        return Array.isArray(vector) && vector.length
          ? { ok: true, status: 200, detail: '', message: 'Embedding 连接正常' }
          : { ok: false, status: 200, detail: '', message: 'Embedding 服务已连通，但返回格式异常（无向量数据）' }
      } catch {
        return { ok: false, status: 0, detail: '', message: '无法连接 Embedding 服务，请检查 Base URL 与网络' }
      } finally { await transport.close() }
    }
    if (input.capability !== 'llm' && input.capability !== 'speech_to_text')
      return { ok: false, status: 0, detail: '', message: '该凭据能力的试呼尚未接通' }
    let request
    try {
      request = providerDiagnosticRequest({ provider: input.provider, api_format: input.apiFormat || undefined,
        base_url: input.baseUrl || undefined, model: input.model, api_key: input.apiKey, timeout_ms: 10_000 })
    } catch {
      return { ok: false, status: 0, detail: '无法连接 Provider，请检查地址、模型和密钥' }
    }
    const local = ['local', 'ollama'].includes(input.provider.toLowerCase())
    const transport = createNodeProviderTransport({ allowLocal: local, connectTimeoutMs: 10_000, environment: () => environment })
    try {
      const response = await transport.request(request, AbortSignal.timeout(10_000))
      const ok = response.status >= 200 && response.status < 400
      await cancel(response)
      return { ok, status: response.status, detail: ok ? '' : `上游返回 HTTP ${response.status}` }
    } catch {
      return { ok: false, status: 0, detail: '无法连接 Provider，请检查地址、模型和密钥' }
    } finally { await transport.close() }
  }
}

export function registerCredentialTestPreviewRoute(app: FastifyInstance, options: CredentialTestPreviewRouteOptions): void {
  app.post('/api/v1/byok/test-preview', { preHandler: options.requireUser }, async (request, reply) => {
    const body = schema.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '凭据参数无效' })
    try { return await options.preview(options.ownerIdFromRequest(request), body.data) }
    catch (error) {
      const current = error as { statusCode?: unknown; code?: unknown }
      const status = Number(current.statusCode) || (current.code === 'not_found' ? 404 : 0)
      if (status === 403 || status === 404 || status === 422)
        return reply.code(status).send({ detail: error instanceof Error ? error.message : '请求无效' })
      return reply.code(502).send({ detail: '凭据测试失败，请检查配置' })
    }
  })
  app.post('/api/v1/byok/:credential_id/test', { preHandler: options.requireUser }, async (request, reply) => {
    const params = z.object({ credential_id: z.coerce.number().int() }).safeParse(request.params)
    if (!params.success) return reply.code(422).send({ detail: '凭据参数无效' })
    try { return await options.savedTest(options.ownerIdFromRequest(request), params.data.credential_id) }
    catch (error) {
      const current = error as { statusCode?: unknown; code?: unknown }
      const status = Number(current.statusCode) || (current.code === 'not_found' ? 404 : 0)
      if (status === 403 || status === 404 || status === 422)
        return reply.code(status).send({ detail: error instanceof Error ? error.message : '请求无效' })
      return reply.code(502).send({ detail: '凭据测试失败，请检查配置' })
    }
  })
}
