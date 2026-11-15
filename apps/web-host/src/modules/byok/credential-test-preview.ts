import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { dashscopeAsrServiceForModel, deepResearchProbe, normalizedApiKey, providerDiagnosticRequest, similarImageProbe, transcribeDashscopeAsr, transcribeMiniMax } from '@gugu/core/providers'
import type { AsrDependencies, CompatibleAsrDependencies, ProviderConfig, ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers'
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

interface CredentialProbeOptions {
  createTransport?: (allowLocal: boolean) => ProviderTransport & { close?(): Promise<void> }
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

function silentWav(): Uint8Array {
  const sampleRate = 16_000, frames = sampleRate
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav
}

function requestDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function providerErrorStatus(error: unknown): number {
  const options = (error as { options?: { status?: unknown } } | null)?.options
  const status = Number(options?.status)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0
}

async function nativeAsrProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], transport: ProviderTransport): Promise<{ ok: boolean; status: number; detail: string; message: string }> {
  let dashscopeService: string | undefined
  if (input.apiFormat === 'dashscope') {
    try { dashscopeService = dashscopeAsrServiceForModel(input.model) }
    catch (error) { return { ok: false, status: 0, detail: '', message: error instanceof Error ? error.message : '百炼原生语音模型不受支持' } }
  } else if (input.provider.toLowerCase() === 'minimax' && input.apiFormat !== 'minimax-asr') {
    return { ok: false, status: 0, detail: '', message: 'MiniMax 语音识别需要选择 MiniMax ASR 接口格式' }
  } else if (input.provider.toLowerCase() !== 'minimax' || input.apiFormat !== 'minimax-asr') {
    return { ok: false, status: 0, detail: '', message: '语音 API 格式暂不支持' }
  }

  let upstreamBody = ''
  const dependencies = {
    transport,
    digest: requestDigest,
    diagnose(code: string, value: unknown) {
      if (code !== 'provider_http') return
      const event = value as { body?: unknown }
      if (event.body !== undefined) upstreamBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body)
    },
  }
  const config: ProviderConfig = {
    provider: input.provider, model: input.model, api_format: input.apiFormat,
    base_url: input.baseUrl, api_key: input.apiKey, timeout_ms: 10_000,
    ...(dashscopeService ? { dashscope_service: dashscopeService } : {}),
  }
  const signal = AbortSignal.timeout(10_000)
  try {
    const media = [{ type: 'audio', mime: 'audio/wav', ext: 'wav', duration: 1, raw: silentWav() }]
    const text = input.apiFormat === 'dashscope'
      ? await transcribeDashscopeAsr(media, config, { ...dependencies, toWav: async () => null } satisfies CompatibleAsrDependencies, signal, { raiseErrors: true })
      : await transcribeMiniMax(media, config, { ...dependencies, probeAudioDuration: async () => 1, toWav: async () => null } satisfies AsrDependencies, signal, { raiseErrors: true })
    return { ok: text !== null, status: 200, detail: '', message: input.provider.toLowerCase() === 'minimax'
      ? 'MiniMax ASR 连接正常' : '连接正常（静音测试已收到响应）' }
  } catch (error) {
    const status = providerErrorStatus(error)
    const detail = safeUpstreamMessage(upstreamBody, input.apiKey)
    const message = status
      ? `语音测试失败（HTTP ${status}）${detail ? `：${detail}` : ''}`
      : '无法连接语音识别服务，请检查 Base URL、模型和 API Key'
    return { ok: false, status, detail: '', message }
  }
}

async function deepResearchCredentialProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], transport: ProviderTransport) {
  try {
    const result = await deepResearchProbe(input.provider, input.apiKey, '测试深度研究连接', 1, 'basic',
      { transport, digest: requestDigest }, AbortSignal.timeout(90_000))
    if (result.error) return { ok: false, status: 0, detail: '', message: `${input.provider} 测试失败，请检查 API Key、服务可用性或调用额度` }
    const foundResults = Array.isArray(result.results) && result.results.length > 0
    if (!result.answer && !foundResults)
      return { ok: false, status: 0, detail: '', message: `${input.provider} 已连通但没有返回研究结果` }
    return { ok: true, status: 200, detail: '', message: `${input.provider} 深度研究连接正常（本次测试可能消耗 1 次调用）` }
  } catch {
    return { ok: false, status: 0, detail: '', message: `${input.provider} 测试失败，请检查 API Key、服务可用性或调用额度` }
  }
}

const similarImageProbePng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlklEQVR4nO3QMQ0AMAzAsPLHWC4rDB/L4T/K7O772egArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0A6OSM1jeqEVYAAAAAElFTkSuQmCC'

async function similarImageCredentialProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], transport: ProviderTransport) {
  try {
    const image = Buffer.from(similarImageProbePng, 'base64')
    const result = await similarImageProbe(input.apiKey, image, 1, { transport, digest: requestDigest }, AbortSignal.timeout(30_000))
    const errors: Record<string, string> = {
      invalid_api_key: '百度相似图搜索 API Key 格式无效，请使用服务提供的 ASCII API Key',
      upstream_auth: '百度相似图搜索鉴权失败，请检查 API Key',
      upstream_rate_limited: '百度相似图搜索调用频率或额度已用尽，请稍后重试',
      upstream_unavailable: '百度相似图搜索暂时不可用，请稍后重试',
      upstream_error: '百度相似图搜索请求失败，请检查服务配置或网络',
    }
    if (result.error_code) return { ok: false, status: 0, detail: '', message: errors[String(result.error_code)] ?? errors.upstream_error }
    return { ok: true, status: 200, detail: '', message: '百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）' }
  } catch {
    return { ok: false, status: 0, detail: '', message: '百度相似图搜索网络连接失败，请稍后重试' }
  }
}

async function embeddingCredentialProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], apiKey: string, local: boolean, transport: ProviderTransport) {
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
  }
}

async function providerDiagnosticCredentialProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], transport: ProviderTransport) {
  let request
  try {
    request = providerDiagnosticRequest({ provider: input.provider, api_format: input.apiFormat || undefined,
      base_url: input.baseUrl || undefined, model: input.model, api_key: input.apiKey, timeout_ms: 10_000 })
  } catch {
    return { ok: false, status: 0, detail: '无法连接 Provider，请检查地址、模型和密钥' }
  }
  try {
    const response = await transport.request(request, AbortSignal.timeout(10_000))
    const ok = response.status >= 200 && response.status < 400
    await cancel(response)
    return { ok, status: response.status, detail: ok ? '' : `上游返回 HTTP ${response.status}` }
  } catch {
    return { ok: false, status: 0, detail: '无法连接 Provider，请检查地址、模型和密钥' }
  }
}

async function withTransport<T>(create: () => ProviderTransport & { close?(): Promise<void> }, run: (transport: ProviderTransport) => Promise<T>): Promise<T> {
  const transport = create()
  try { return await run(transport) }
  finally { await transport.close?.() }
}

/** LLM/ASR OpenAI兼容诊断走生产 Provider transport；不跟随重定向或回显上游正文。 */
export function createByokCredentialTestProbe(environment: NodeJS.ProcessEnv, options: CredentialProbeOptions = {}) {
  return async (input: Parameters<CredentialTestPreviewOptions['probe']>[0]) => {
    const local = ['local', 'ollama'].includes(input.provider.trim().toLowerCase())
    const createTransport = () => options.createTransport?.(local)
      ?? createNodeProviderTransport({ allowLocal: local, connectTimeoutMs: 10_000, environment: () => environment })
    if (input.capability === 'deep_research') return withTransport(createTransport, transport => deepResearchCredentialProbe(input, transport))
    if (input.capability === 'similar_image_search') return withTransport(createTransport, transport => similarImageCredentialProbe(input, transport))
    if (input.capability === 'embedding') {
      let apiKey: string
      try { apiKey = normalizedApiKey(input.apiKey) }
      catch { return { ok: false, status: 0, detail: '', message: '无法连接 Embedding 服务，请检查 Base URL 与网络' } }
      return withTransport(createTransport, transport => embeddingCredentialProbe(input, apiKey, local, transport))
    }
    if (input.capability === 'speech_to_text' && (input.apiFormat === 'dashscope' || input.provider.toLowerCase() === 'minimax'))
      return withTransport(createTransport, transport => nativeAsrProbe(input, transport))
    if (input.capability !== 'llm' && input.capability !== 'speech_to_text')
      return { ok: false, status: 0, detail: '', message: '该凭据能力的试呼尚未接通' }
    return withTransport(createTransport, transport => providerDiagnosticCredentialProbe(input, transport))
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
