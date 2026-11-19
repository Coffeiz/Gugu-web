import { readOwnedCredential, type OwnedCredential } from '../store.js'
import { createHash } from 'node:crypto'
import { dashscopeAsrServiceForModel, deepResearchProbe, normalizedApiKey, providerDiagnosticRequest, similarImageProbe, transcribeDashscopeAsr, transcribeMiniMax, type AsrDependencies, type CompatibleAsrDependencies, type ProviderConfig, type ProviderHttpResponse, type ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { redactToolError } from '@gugu/core/agent'
import type { Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'

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

async function nativeAsrProbe(input: Parameters<CredentialTestPreviewOptions['probe']>[0], transport: ProviderTransport): Promise<{ ok: boolean; status?: number; detail: string; message: string }> {
  let dashscopeService: string | undefined
  const dashscope = input.apiFormat === 'dashscope'
  if (dashscope) {
    try { dashscopeService = dashscopeAsrServiceForModel(input.model) }
    catch (error) { return { ok: false, status: 0, detail: '', message: error instanceof Error ? error.message : '百炼原生语音模型不受支持' } }
    if (!input.baseUrl.trim()) return { ok: false, detail: '', message: '请先填写模型名和 Base URL' }
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
    const text = dashscope
      ? await transcribeDashscopeAsr(media, config, { ...dependencies, toWav: async () => null } satisfies CompatibleAsrDependencies, signal, { raiseErrors: true })
      : await transcribeMiniMax(media, config, { ...dependencies, probeAudioDuration: async () => 1, toWav: async () => null } satisfies AsrDependencies, signal, { raiseErrors: true })
    if (text === null) return { ok: false, ...(dashscope ? {} : { status: 0 }), detail: '', message: '语音模型未配置' }
    return { ok: true, ...(dashscope ? {} : { status: 200 }), detail: '', message: dashscope
      ? '连接正常（静音测试已收到响应）' : 'MiniMax ASR 连接正常' }
  } catch (error) {
    const status = providerErrorStatus(error)
    const detail = safeUpstreamMessage(upstreamBody, input.apiKey)
    const message = status
      ? `语音测试失败（HTTP ${status}）${detail ? `：${detail}` : ''}`
      : '无法连接语音识别服务，请检查 Base URL、模型和 API Key'
    return { ok: false, ...(dashscope ? {} : { status }), detail: '', message }
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

export interface CredentialTestPreviewInput {
  provider: string
  capability: 'deep_research' | 'similar_image_search' | 'embedding' | 'llm' | 'speech_to_text'
  value?: string
  api_format?: string
  base_url?: string
  model?: string
  dimensions?: number | null
  credential_id?: number | null
}

export interface CredentialTestPreviewOptions {
  enabled: () => boolean
  decrypt: (row: Pick<OwnedCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>) => Promise<string>
  probe: (input: {
    provider: string
    capability: CredentialTestPreviewInput['capability']
    apiFormat: string
    baseUrl: string
    model: string
    dimensions?: number | null
    apiKey: string
  }) => Promise<{ ok: boolean; status?: number; detail: string; message?: string }>
}

function probeResponse(capability: CredentialTestPreviewInput['capability'], result: Awaited<ReturnType<CredentialTestPreviewOptions['probe']>>) {
  const genericModel = capability === 'llm' || capability === 'speech_to_text'
  const message = result.message ?? (genericModel
    ? result.ok ? '模型连接正常' : result.status ? `模型连接失败（HTTP ${result.status}）` : result.detail
    : result.detail)
  return { ok: result.ok, ...(result.status === undefined ? {} : { status: result.status }), message }
}

const canUseKeylessEmbedding = (input: CredentialTestPreviewInput): boolean =>
  input.capability === 'embedding' && (input.provider === 'local' ||
    (input.provider === 'ollama' && !((input.base_url ?? '').includes('ollama.com'))))

/** 按 Python test-preview 契约验证草稿，所有读取按认证 owner 限定且不写入。 */
export function createCredentialTestPreview<DB>(db: Kysely<DB>, options: CredentialTestPreviewOptions) {
  return async (ownerId: string, input: CredentialTestPreviewInput) => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    if (input.provider === '__server_default__')
      return { ok: false, status: 0, message: '服务器默认配置不支持用户侧测试' }

    const apiFormat = input.api_format ?? ''
    const baseUrl = input.base_url ?? ''
    const model = input.model ?? ''
    const suppliedKey = input.value ?? ''
    const owner = dataContext(ownerId).ownerId
    let row: OwnedCredential | undefined
    if (!suppliedKey && input.credential_id != null) {
      row = await readOwnedCredential(db, owner, input.credential_id)
    }

    let apiKey = suppliedKey
    if (!apiKey && canUseKeylessEmbedding(input)) {
      apiKey = ''
    } else if (!apiKey) {
      if (!row) return { ok: false, status: 0, message: '请填写 API Key 后再测试' }
      const target = { provider: input.provider, api_format: apiFormat, base_url: baseUrl, model,
        capability: row.capability }
      if (!canReuseByokKeyForDestination(row, target))
        return { ok: false, status: 0, message: BYOK_DESTINATION_MISMATCH_MESSAGE }
      try { apiKey = await options.decrypt(row) }
      catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }
    }

    if (input.capability === 'embedding' && (!baseUrl || !model))
      return { ok: false, status: 0, message: 'Embedding 测试需要填写 Base URL 和模型名' }

    const result = await options.probe({ provider: input.provider, capability: input.capability,
      apiFormat, baseUrl, model, ...(input.dimensions == null ? {} : { dimensions: input.dimensions }), apiKey })
    return probeResponse(input.capability, result)
  }
}

/** 测试已保存凭据：先 owner 限定读取并解密，再进行一次不写库的能力探测。 */
export function createCredentialSavedTest<DB>(db: Kysely<DB>, options: CredentialTestPreviewOptions) {
  return async (ownerId: string, credentialId: number) => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    const owner = dataContext(ownerId).ownerId
    const row = await readOwnedCredential(db, owner, credentialId, true)
    let apiKey: string
    try { apiKey = await options.decrypt(row) }
    catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }

    if (row.capability === 'embedding' && (!row.base_url || !row.model))
      return { ok: false, status: 0, message: '请先填写 Base URL 和模型名再测试' }
    if (row.capability !== 'llm' && row.capability !== 'speech_to_text' && row.capability !== 'embedding'
        && row.capability !== 'deep_research' && row.capability !== 'similar_image_search')
      return { ok: true, status: 'stored', message: '凭据已保存且可正常解密' }

    const probe = await options.probe({ provider: row.provider, capability: row.capability,
      apiFormat: row.api_format ?? '', baseUrl: row.base_url ?? '', model: row.model ?? '',
      ...(row.dimensions == null ? {} : { dimensions: row.dimensions }), apiKey })
    return probeResponse(row.capability, probe)
  }
}
