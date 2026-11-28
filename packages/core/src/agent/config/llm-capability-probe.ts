import { createHash } from 'node:crypto'
import { capabilitySnapshot, providerSelection, type ProviderConfig, type ProviderHttpRequest, type ProviderTransport } from '../providers/index.js'
import { ensureLlmPresets, LlmStrategyConfigurationError, type LlmStrategyMutator } from './llm-strategy.js'
import { llmAiSegment } from './llm-preset-selection.js'

type Document = Record<string, unknown>
type ProbeStatus = { status: string; detail: string }
type ProbeResults = Record<'chat' | 'stream' | 'tools' | 'json_object' | 'json_schema' | 'reasoning', ProbeStatus>
const record = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)

export class LlmCapabilityProbeError extends Error {
  override name = 'LlmCapabilityProbeError'
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) }
}

function fingerprint(item: Document): string {
  const value = ['provider', 'local_runtime', 'base_url', 'model'].map(key => {
    const part = Object.hasOwn(item, key) ? item[key] : ''
    return part === null ? 'None' : part === true ? 'True' : part === false ? 'False' : String(part)
  }).join('|')
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function detail(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

async function status(transport: ProviderTransport, request: ProviderHttpRequest): Promise<number> {
  const response = await transport.request(request, AbortSignal.timeout(request.timeoutMs ?? 30_000))
  try {
    if (request.body && (request.body as Record<string, unknown>).stream === true && response.status < 400) {
      const iterator = response.body[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()
    }
    return response.status
  } finally { await response.cancel() }
}

/** 对已保存模型执行 Python 兼容能力探测；所有网络能力由 Host 的安全 transport 提供。 */
export async function probeLlmProviderCapabilities(config: ProviderConfig, transport: ProviderTransport): Promise<ProbeResults> {
  const provider = (config.provider ?? '').trim().toLowerCase()
  if (provider === 'ollama' && (config.ollama_api_mode ?? 'native') === 'native')
    throw new LlmCapabilityProbeError(400, 'Ollama 原生模式请使用连通性/多模态检测；能力探测接口仅支持 OpenAI 兼容模式')

  const { policy, config: filtered, driver } = providerSelection(config)
  const base = policy.baseUrl(filtered).replace(/\/+$/, '')
  if (!base) throw new Error('invalid provider endpoint')
  const key = config.api_key || (policy.name === 'ollama' ? 'ollama' : 'local')
  const headers = { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...policy.headers(filtered) }
  const endpoint = (path: string) => `${base}/${path}`
  const responsesProtocol = driver.protocol === 'responses'
  const responsesBase = { model: config.model, input: '请只输出 JSON 对象：{"ok":true}。', max_output_tokens: 128, stream: false }
  const request = (body?: Record<string, unknown>): ProviderHttpRequest => ({
    url: endpoint(responsesProtocol ? 'responses' : body ? 'chat/completions' : 'models'),
    method: responsesProtocol || body ? 'POST' : 'GET', headers,
    ...(responsesProtocol ? { body: { ...responsesBase, ...body } }
      : body ? { body: { model: config.model, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 4, ...body } } : {}),
    timeoutMs: 30_000, allowLocal: ['local', 'ollama'].includes(provider),
  })
  const results: ProbeResults = {
    chat: { status: '未检测', detail: '' }, stream: { status: '未检测', detail: '' },
    tools: { status: '未检测', detail: '' }, json_object: { status: '未检测', detail: '' },
    json_schema: { status: '未检测', detail: '' }, reasoning: { status: '未检测', detail: '' },
  }
  try {
    const code = await status(transport, request(responsesProtocol ? {} : undefined))
    results.chat = { status: (responsesProtocol ? code >= 200 && code < 300 : code < 400) ? '支持' : '检测失败', detail: `${responsesProtocol ? 'Responses ' : ''}HTTP ${code}` }
  } catch (error) { results.chat = { status: '检测失败', detail: detail(error) }; return results }

  const checks: Array<[keyof ProbeResults, Record<string, unknown>, string]> = [
    ['chat', {}, '检测失败'],
    ['stream', { stream: true }, '检测失败'],
    ['tools', { tools: [responsesProtocol ? { type: 'function', name: 'probe_noop', description: '无副作用测试工具', parameters: { type: 'object' } }
      : { type: 'function', function: { name: 'probe_noop', description: '无副作用测试工具', parameters: { type: 'object' } } }], ...(responsesProtocol ? {} : { tool_choice: 'auto' }) }, '需服务端配置'],
    ['json_object', responsesProtocol ? { text: { format: { type: 'json_object' } } } : { response_format: { type: 'json_object' } }, '需服务端配置'],
    ['json_schema', responsesProtocol ? { text: { format: { type: 'json_schema', name: 'probe', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, strict: true } } }
      : { response_format: { type: 'json_schema', json_schema: { name: 'probe', schema: { type: 'object' } } } }, '需服务端配置'],
  ]
  for (const [name, body, defaultFailure] of checks) {
    if (responsesProtocol && name === 'chat') continue
    const failure = responsesProtocol ? '检测失败' : defaultFailure
    try {
      const code = await status(transport, request(body))
      results[name] = { status: (responsesProtocol ? code >= 200 && code < 300 : code < 400) ? '支持' : failure,
        detail: `${responsesProtocol ? 'Responses ' : ''}HTTP ${code}` }
    } catch (error) { results[name] = { status: failure, detail: detail(error) } }
  }
  results.reasoning = { status: '未检测', detail: '推理字段依赖模型与服务端配置，请人工确认' }
  return results
}

export function createLlmCapabilityProbe(ports: {
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  createTransport(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
  invalidate(): Promise<unknown>
}) {
  return async (id: string) => {
    let item: Document
    try {
      const raw = await ports.readDocument()
      if (!record(raw)) throw new Error('invalid config document')
      const presets = ensureLlmPresets(structuredClone(raw))
      if (!Array.isArray(presets.items)) throw new Error('invalid preset list')
      const found = presets.items.find(value => record(value) && value.id === id)
      if (!record(found)) throw new LlmCapabilityProbeError(404, '预设不存在')
      item = structuredClone(found)
    } catch (error) {
      if (error instanceof LlmCapabilityProbeError) throw error
      throw new LlmCapabilityProbeError(503, '暂时无法读取模型配置')
    }
    let declaredCapabilities: Record<string, unknown>
    try { declaredCapabilities = capabilitySnapshot(item as ProviderConfig) }
    catch { throw new LlmCapabilityProbeError(503, '暂时无法读取模型配置') }
    const expectedFingerprint = fingerprint(item)
    let results: ProbeResults
    const transport = ports.createTransport(item as ProviderConfig)
    try { results = await probeLlmProviderCapabilities(item as ProviderConfig, transport) }
    finally { await transport.close?.().catch(() => undefined) }
    const checkedAt = new Date().toISOString()
    try {
      await ports.mutate(document => {
        let presets: Document
        try { presets = ensureLlmPresets(document) } catch { throw new LlmStrategyConfigurationError() }
        if (!Array.isArray(presets.items)) throw new LlmStrategyConfigurationError()
        const current = presets.items.find(value => record(value) && value.id === id)
        if (!record(current)) throw new LlmCapabilityProbeError(404, '预设不存在')
        if (fingerprint(current) !== expectedFingerprint) throw new LlmCapabilityProbeError(409, '探测期间预设已更改，请重新探测')
        current.capability_checked_at = checkedAt
        current.capability_fingerprint = expectedFingerprint
        current.capability_probe = results
        if (presets.active_id === id) document.ai = llmAiSegment(current)
      })
    } catch (error) {
      if (error instanceof LlmCapabilityProbeError) throw error
      throw new LlmCapabilityProbeError(503, '暂时无法保存模型配置')
    }
    await ports.invalidate()
    return { fingerprint: expectedFingerprint, checked_at: checkedAt, results, declared_capabilities: declaredCapabilities }
  }
}
