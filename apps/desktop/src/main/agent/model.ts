import { stableJson } from '@gugu/core/agent'
import { DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS, isMiniMaxAnthropicEndpointMigration } from '@gugu/core/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopAgentModel, DesktopAgentModelList, DesktopAgentModelOptions } from '@gugu/core/desktop'
import { capabilitySnapshot, completeStandaloneText, listProviderModels, normalizedApiKey, ProviderError, providerErrorMessage, supportsProviderSearch, type ProviderConfig } from '@gugu/core/providers'
import { createByokMediaCapabilityProbeRunner } from '@gugu/core/providers/media-probe'
import { createNodeProviderTransport, desktopModelTransportOptions } from '@gugu/core/providers/node'
import { createEncryptedDesktopStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'

type Preset = DesktopAgentModel & { apiKey: string }
type StoredModel = { id: string; preset: Preset }
type ModelStore = { items: StoredModel[]; defaultId: string | null }
type Encryption = Parameters<typeof createEncryptedDesktopStore>[2]

function localEndpoint(url: URL) {
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

const providers = new Set(['openai', 'anthropic', 'qwen', 'glm', 'glm-coding', 'deepseek', 'minimax', 'mimo', 'ollama', 'local'])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function providerConfig(preset: Preset): ProviderConfig {
  return {
    provider: preset.provider, api_format: preset.apiFormat === 'native' ? undefined : preset.apiFormat,
    ...(preset.provider === 'ollama' && { ollama_api_mode: preset.apiFormat === 'native' ? 'native' : 'openai' }),
    local_runtime: preset.localRuntime, ollama_mode: preset.ollamaMode,
    max_tokens: preset.maxTokens, context_tokens: preset.contextTokens, web_search_enabled: preset.webSearchEnabled,
    ...(preset.thinkingMode && preset.thinkingMode !== 'default' && {
      thinking: preset.thinkingMode === 'disabled' ? 'disabled' : 'adaptive',
      ...(!['adaptive', 'disabled'].includes(preset.thinkingMode) && { reasoning_effort: preset.thinkingMode }),
    }),
    reasoning_persistence: preset.reasoningPersistence ?? 'off',
    image: preset.image, audio: preset.audio, video: preset.video,
    base_url: preset.baseUrl, api_key: preset.apiKey, model: preset.model, timeout_ms: 10_000,
  }
}

function modelOptions(value: Record<string, unknown>): DesktopAgentModelOptions {
  const options: DesktopAgentModelOptions = {
    contextTokens: DEFAULT_LLM_CONTEXT_TOKENS,
    maxTokens: DEFAULT_LLM_OUTPUT_TOKENS,
  }
  for (const key of ['contextTokens', 'maxTokens'] as const) {
    const amount = value[key]
    if (amount == null) continue
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw new Error()
    options[key] = amount
  }
  for (const key of ['image', 'audio', 'video', 'webSearchEnabled'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new Error()
    options[key] = value[key]
  }
  const { localRuntime, ollamaMode, thinkingMode, reasoningPersistence } = value
  if (localRuntime !== undefined) {
    if (localRuntime !== 'llama.cpp' && localRuntime !== 'vllm' && localRuntime !== 'other') throw new Error()
    options.localRuntime = localRuntime
  }
  if (ollamaMode !== undefined) {
    if (ollamaMode !== 'local' && ollamaMode !== 'cloud') throw new Error()
    options.ollamaMode = ollamaMode
  }
  if (thinkingMode !== undefined) {
    if (typeof thinkingMode !== 'string' || !['default', 'disabled', 'adaptive', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingMode)) throw new Error()
    options.thinkingMode = thinkingMode
  }
  if (reasoningPersistence !== undefined) {
    if (reasoningPersistence !== 'off' && reasoningPersistence !== 'continuation') throw new Error()
    options.reasoningPersistence = reasoningPersistence
  }
  return options
}

function parsePreset(value: unknown, mode: 'save' | 'models' | 'capabilities' = 'save'): Preset {
  try {
    if (!value || typeof value !== 'object' || !('baseUrl' in value) || !('model' in value) || !('apiKey' in value)) throw new Error()
    const { baseUrl, model, apiKey } = value
    if (typeof baseUrl !== 'string' || baseUrl.length > 500 || typeof model !== 'string' || model.length > 200
        || typeof apiKey !== 'string' || apiKey.length > 20_000) throw new Error()
    if (mode === 'save' && !model.trim()) throw new DesktopError('invalid_request', '请填写模型 ID')
    let key: string
    try { key = normalizedApiKey(apiKey) }
    catch { throw new DesktopError('invalid_request', 'API Key 含无效字符，请重新复制') }
    const providerField = 'provider' in value ? value.provider : undefined
    const apiFormat = 'apiFormat' in value ? value.apiFormat : 'openai'
    if (typeof apiFormat !== 'string' || (providerField !== undefined && (typeof providerField !== 'string' || !providers.has(providerField)))) throw new Error()
    const providerHint = typeof providerField === 'string' ? providerField : 'openai'
    const options = modelOptions(value as Record<string, unknown>)
    const defaultConfig = providerConfig({ ...options, model: model.trim(), provider: providerHint, apiFormat, baseUrl: '', apiKey: key })
    const defaultUrl = baseUrl.trim() ? baseUrl : capabilitySnapshot({ ...defaultConfig, base_url: undefined }).default_base_url
    const url = new URL(defaultUrl)
    if (url.username || url.password || url.search || url.hash) throw new Error()
    if (providerHint === 'minimax' && url.hostname === 'api.minimaxi.cn')
      throw new DesktopError('invalid_request', '接口地址无效')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localEndpoint(url))) throw new Error()
    const provider = providerField ?? (localEndpoint(url) ? 'local' : 'openai')
    const allowLocal = localEndpoint(url) && (provider === 'local' || provider === 'ollama')
    if (localEndpoint(url) && !allowLocal) throw new Error()
    if (!allowLocal && !key && mode !== 'capabilities') throw new DesktopError('invalid_request', '请填写此接口的 API Key')
    const preset = { ...options, baseUrl: url.href.replace(/\/+$/, ''), model: model.trim(), apiKey: key, provider, apiFormat }
    if (!capabilitySnapshot(providerConfig(preset)).selectable_api_formats.includes(apiFormat))
      throw new DesktopError('invalid_request', '所选 Provider 不支持当前接口格式')
    return preset
  } catch (error) {
    if (error instanceof DesktopError) throw error
    throw new DesktopError('invalid_request', '请填写有效的模型及 HTTPS 接口地址。回环地址支持 HTTP。')
  }
}

function summary(preset: Preset): DesktopAgentModel {
  const { baseUrl, model, provider, apiFormat } = preset
  const { apiKey: _key, ...options } = preset
  return { ...options, baseUrl, model, provider, apiFormat }
}

const legacyModelId = '00000000-0000-4000-8000-000000000000'

function parseModelStore(value: unknown): ModelStore | Preset {
  if (!value || typeof value !== 'object' || !('items' in value)) return parsePreset(value)
  if (!Array.isArray(value.items) || !('defaultId' in value)) throw new Error('模型列表无效')
  const items = value.items.map((item: unknown): StoredModel => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !('preset' in item))
      throw new Error('模型配置无效')
    return { id: item.id, preset: parsePreset(item.preset) }
  })
  const ids = new Set(items.map(item => item.id))
  const { defaultId } = value
  if (ids.size !== items.length || (items.length === 0 ? defaultId !== null : typeof defaultId !== 'string' || !ids.has(defaultId)))
    throw new Error('默认模型配置无效')
  return { items, defaultId: typeof defaultId === 'string' ? defaultId : null }
}

function listSummary(state: ModelStore): DesktopAgentModelList {
  return { defaultId: state.defaultId, items: state.items.map(({ id, preset }) => ({ id, ...summary(preset) })) }
}

function findModel(state: ModelStore, id: string): StoredModel {
  const entry = state.items.find(item => item.id === id)
  if (!entry) throw new DesktopError('invalid_request', '该模型配置已不存在')
  return entry
}

export function createDesktopAgentModelStore(directory: string, encryption: Encryption) {
  const filename = 'agent-model'
  const store = createEncryptedDesktopStore(directory, filename, encryption, parseModelStore)
  return {
    async read(): Promise<{ state: ModelStore; legacy: boolean }> {
      const stored = await store.read()
      if (stored === null) return { state: { items: [], defaultId: null }, legacy: false }
      if ('items' in stored) return { state: stored, legacy: false }
      return { state: { items: [{ id: legacyModelId, preset: stored }], defaultId: legacyModelId }, legacy: true }
    },
    async write(state: ModelStore, legacy: boolean) {
      if (legacy) {
        const path = join(directory, filename)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        try {
          await copyFile(path, `${path}.${timestamp}.${randomUUID()}.bak`, constants.COPYFILE_EXCL)
        } catch {
          throw new DesktopError('credential_store', '无法备份原有模型配置，请重试')
        }
      }
      await store.write(state)
    },
  }
}

export function createDesktopAgentModelService(store: ReturnType<typeof createDesktopAgentModelStore>,
  resolveProxy?: ReturnType<typeof desktopModelTransportOptions>['resolveProxy'],
) {
  let testing = false
  let writes: Promise<unknown> = Promise.resolve()
  const runMediaProbe = createByokMediaCapabilityProbeRunner(process.env, config => desktopModelTransportOptions(config, resolveProxy))
  const read = async () => (await store.read()).state

  function mutate<T>(change: (state: ModelStore) => T): Promise<T> {
    const result = writes.then(async () => {
      const { state, legacy } = await store.read()
      const response = change(state)
      await store.write(state, legacy)
      return response
    })
    writes = result.catch(() => {})
    return result
  }

  function resolveDraft(draft: unknown, mode: 'save' | 'models', saved?: Preset) {
    const candidate = draft as Partial<Preset> | null
    const canUseSavedKey = saved && candidate?.apiKey === '' && candidate.provider === saved.provider
      && (candidate.baseUrl === saved.baseUrl || (
        typeof candidate.baseUrl === 'string' && typeof candidate.apiFormat === 'string'
        && isMiniMaxAnthropicEndpointMigration(saved, { provider: candidate.provider, apiFormat: candidate.apiFormat, baseUrl: candidate.baseUrl })
      ))
    return parsePreset(canUseSavedKey ? { ...candidate, apiKey: saved.apiKey } : draft, mode)
  }

  async function readDraft(draft: unknown, mode: 'save' | 'models', id?: string | null) {
    const state = await read()
    const selected = id === undefined ? state.defaultId : id
    return resolveDraft(draft, mode, selected === null ? undefined : findModel(state, selected).preset)
  }

  function putModel(state: ModelStore, draft: unknown, id: string | null) {
    const existing = id === null ? undefined : findModel(state, id)
    const preset = resolveDraft(draft, 'save', existing?.preset)
    if (preset.webSearchEnabled && (!preset.apiKey || !supportsProviderSearch(providerConfig(preset))))
      throw new DesktopError('invalid_request', '当前模型配置不支持联网搜索，请检查接口地址、API 格式和 API Key')
    if (existing) {
      existing.preset = preset
    } else {
      const newId = randomUUID()
      state.items.push({ id: newId, preset })
      state.defaultId ??= newId
    }
    return preset
  }

  async function withProvider<T>(
    preset: Preset,
    request: (config: ProviderConfig, transport: ReturnType<typeof createNodeProviderTransport>) => Promise<T>,
  ): Promise<T> {
    const config = providerConfig(preset)
    const transport = createNodeProviderTransport(desktopModelTransportOptions(config, resolveProxy))
    try {
      return await request(config, transport)
    } catch (error) {
      if (error instanceof DesktopError) throw error
      if (error instanceof ProviderError) throw new DesktopError('model_unavailable', providerErrorMessage(error))
      throw new DesktopError('model_unavailable', '模型连接失败，请检查接口地址、模型和 API Key')
    } finally {
      await transport.close()
    }
  }

  async function probe<T>(
    load: () => Promise<Preset>,
    request: (config: ProviderConfig, transport: ReturnType<typeof createNodeProviderTransport>, signal: AbortSignal, preset: Preset) => Promise<T>,
  ): Promise<T> {
    if (testing) throw new DesktopError('busy', '正在测试模型连接')
    testing = true
    try {
      const preset = await load()
      return await withProvider(preset, (config, transport) => request(config, transport, AbortSignal.timeout(12_000), preset))
    } finally {
      testing = false
    }
  }

  async function selectChatPreset(modelId?: string): Promise<StoredModel> {
    const state = await read()
    const selected = modelId ?? state.defaultId
    if (selected === null) throw new DesktopError('model_unavailable', '请先在模型配置中添加模型')
    return findModel(state, selected)
  }

  async function resolveRunModelSelection(modelId?: string) {
    const selected = await selectChatPreset(modelId)
    return { id: selected.id, config: { ...providerConfig(selected.preset), timeout_ms: 90_000 } }
  }

  return {
    capabilities(model: unknown) {
      const input = model && typeof model === 'object' ? { ...model, apiKey: '' } : model
      const preset = parsePreset(input, 'capabilities')
      return capabilitySnapshot(providerConfig(preset))
    },
    async probeMedia(draft: unknown, dim: unknown, id?: string | null) {
      if (dim !== 'image' && dim !== 'audio' && dim !== 'video')
        throw new DesktopError('invalid_request', '媒体类型无效')
      if (testing) throw new DesktopError('busy', '正在测试模型连接')
      testing = true
      try {
        const preset = await readDraft(draft, 'save', id)
        const result = await runMediaProbe(preset, dim)
        return { dim, ...result }
      } finally {
        testing = false
      }
    },
    async get() {
      const state = await read()
      return state.defaultId === null ? null : summary(findModel(state, state.defaultId).preset)
    },
    async list() {
      return listSummary(await read())
    },
    save(draft: unknown) {
      return mutate(state => summary(putModel(state, draft, state.defaultId)))
    },
    put(draft: unknown, id: string | null) {
      return mutate(state => {
        putModel(state, draft, id)
        return listSummary(state)
      })
    },
    setDefault(id: string) {
      return mutate(state => {
        state.defaultId = findModel(state, id).id
        return listSummary(state)
      })
    },
    remove(id: string) {
      return mutate(state => {
        findModel(state, id)
        state.items = state.items.filter(item => item.id !== id)
        if (state.defaultId === id) state.defaultId = state.items[0]?.id ?? null
        return listSummary(state)
      })
    },
    models(draft: unknown, id?: string | null) {
      return probe(() => readDraft(draft, 'models', id), async (config, transport, signal) => {
        let entries: readonly unknown[]
        try {
          entries = await listProviderModels({ ...config, model: config.model || 'model-list' }, { transport, digest }, signal)
        } catch (error) {
          if (error instanceof ProviderError && (error.code === 'input_rejected' || error.code === 'unsupported' || error.code === 'protocol'
            || [404, 405, 501].includes(error.options.status ?? 0))) {
            const { status, upstreamCode } = error.options
            const detail = [status && `HTTP ${status}`, upstreamCode && /^\d{1,8}$/.test(upstreamCode) && `上游状态 ${upstreamCode}`].filter(Boolean).join('，')
            throw new DesktopError('model_list_unavailable',
              `当前接口未返回模型列表${detail ? `（${detail}）` : ''}。请核对接口地址和协议，或直接填写模型 ID 后测试连接。`)
          }
          throw error
        }
        return [...new Set(entries.flatMap(entry => {
          if (!entry || typeof entry !== 'object') return []
          const id = 'id' in entry ? entry.id : 'name' in entry ? entry.name : 'model' in entry ? entry.model : undefined
          return typeof id === 'string' && id.trim() && id.length <= 200 ? [id] : []
        }))].slice(0, 500)
      })
    },
    async resolveReflectionModel(modelIdentity: unknown, modelId: unknown) {
      if (typeof modelIdentity !== 'string' || !/^[0-9a-f]{64}$/u.test(modelIdentity)) return null
      if (modelId !== null && (typeof modelId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(modelId))) return null
      const candidates = (await read()).items.filter(item => modelId === null || item.id === modelId)
        .map(item => providerConfig(item.preset)).filter(config =>
          createHash('sha256').update(stableJson([config.provider, config.api_format, config.base_url, config.model])).digest('hex') === modelIdentity)
      return candidates.length === 1 ? { ...candidates[0]!, timeout_ms: 90_000 } : null
    },
    resolveRunModelSelection,
    async resolveRunModel(modelId?: string): Promise<ProviderConfig> {
      return (await resolveRunModelSelection(modelId)).config
    },
    async completeGreeting(prompt: string, signal: AbortSignal) {
      const { preset } = await selectChatPreset()
      signal.throwIfAborted()
      const greetingId = randomUUID()
      return withProvider(preset, (config, transport) => completeStandaloneText({
        config, prompt, maxTokens: 180, signal,
        identity: { ownerId: 'desktop', sessionId: 'greeting', runId: greetingId },
      }, { transport, digest }))
    },
    test(id?: string | null, draft?: unknown) {
      return probe(async () => {
        if (draft !== undefined) return readDraft(draft, 'save', id)
        const state = await read()
        const selected = id ?? state.defaultId
        if (selected === null) throw new DesktopError('invalid_request', '请先保存模型配置')
        return findModel(state, selected).preset
      }, async (config, transport, signal, preset) => {
        const text = await completeStandaloneText({
          config,
          prompt: '请只回复 OK。', maxTokens: 64, exactMaxTokens: true,
          signal,
          identity: { ownerId: 'desktop-model-test', sessionId: randomUUID(), runId: randomUUID() },
        }, { transport, digest })
        if (!text) throw new DesktopError('model_unavailable', '模型已响应，但没有返回可见文本')
        return summary(preset)
      })
    },
  }
}
