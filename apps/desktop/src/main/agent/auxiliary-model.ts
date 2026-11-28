import { createHash } from 'node:crypto'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import {
  desktopAuxiliaryModelCommand, desktopAuxiliaryModelStorage,
  type DesktopAuxiliaryModelDraft, type DesktopAuxiliaryModelResult, type DesktopAuxiliaryModelSummary,
} from '@gugu/core/byok/contracts'
import { createByokCredentialTestProbe } from '@gugu/core/byok/credential-probe'
import {
  adapterFor, dashscopeAsrEndpoint, dashscopeAsrServiceForModel, listProviderModels, minimaxAsrEndpoint,
  MINIMAX_ASR_MAX_FILE_BYTES, normalizedApiKey, ollamaNativeBaseUrl,
  transcribeCompatibleAsr, transcribeMiniMax,
  type AsrDependencies, type AsrMedia, type ProviderConfig,
} from '@gugu/core/providers'
import { supportsConfiguredVoiceModel } from '@gugu/core/agent/config/voice-availability'
import { createImVoiceTranscriber, IM_VOICE_MAX_NATIVE_BYTES, type ImVoiceSelection } from '@gugu/gateway/media'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import { createEncryptedDesktopStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'

type StoredModel = DesktopAuxiliaryModelDraft & { id: number; enabled: boolean }
const speechProviders = new Set(['openai', 'qwen', 'minimax', 'local'])
const embeddingProviders = new Set(['openai', 'qwen', 'glm', 'glm-coding', 'ollama', 'local'])

function isLoopback(url: URL) {
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]'
}

function auxiliaryConfig(draft: Omit<DesktopAuxiliaryModelDraft, 'value' | 'capability'>): ProviderConfig {
  return {
    provider: draft.provider,
    api_format: draft.api_format === 'native' ? undefined : draft.api_format || undefined,
    ollama_api_mode: draft.api_format === 'native' ? 'native' : 'openai',
    ollama_mode: draft.ollama_mode,
    local_runtime: draft.local_runtime,
    base_url: draft.base_url || undefined,
    model: draft.model,
  }
}

function destination(draft: Omit<DesktopAuxiliaryModelDraft, 'value' | 'capability'>): string {
  const config = auxiliaryConfig(draft)
  let url: URL
  try {
    const configured = config.base_url ?? (draft.provider === 'minimax' && draft.api_format === 'minimax-asr'
      ? 'https://api.minimax.cn' : adapterFor(config).baseUrl(config))
    url = new URL(configured)
  } catch {
    throw new DesktopError('invalid_request', '请填写有效的接口地址')
  }
  const local = isLoopback(url) && (draft.provider === 'local' || draft.provider === 'ollama')
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
    throw new DesktopError('invalid_request', '请填写有效的 HTTPS 接口地址，本机回环服务支持 HTTP')
  if (isLoopback(url) && !local) throw new DesktopError('invalid_request', '回环接口需要选择本地 Provider')
  const baseUrl = url.href.replace(/\/+$/, '')
  try {
    if (draft.api_format === 'minimax-asr') return minimaxAsrEndpoint(baseUrl)
    if (draft.api_format === 'dashscope') return dashscopeAsrEndpoint(baseUrl)
    if (draft.provider === 'ollama') {
      if (draft.api_format === 'native') return ollamaNativeBaseUrl({ ...config, base_url: baseUrl })
      return baseUrl.replace(/\/api$/, '/v1')
    }
    return baseUrl
  } catch {
    throw new DesktopError('invalid_request', '接口地址与当前 Provider 或格式不匹配')
  }
}

function normalizeDraft(input: DesktopAuxiliaryModelDraft, saved?: StoredModel, clearLocalKey = false): DesktopAuxiliaryModelDraft {
  const allowed = input.capability === 'speech_to_text' ? speechProviders : embeddingProviders
  const formats = input.capability === 'embedding' ? ['', 'openai', ...(input.provider === 'ollama' ? ['native'] : [])]
    : input.provider === 'minimax' ? ['minimax-asr'] : input.provider === 'qwen' ? ['openai', 'dashscope'] : ['', 'openai']
  if (!allowed.has(input.provider) || !formats.includes(input.api_format))
    throw new DesktopError('invalid_request', '该模型类型不支持所选 Provider 或接口格式')
  const base_url = destination(input)
  const model = input.model.trim()
  if (input.capability === 'embedding' && !model) throw new DesktopError('invalid_request', '请填写 Embedding 模型名')
  const keyless = input.capability === 'embedding' && isLoopback(new URL(base_url))
  const value = resolveKey(input.value, input.provider, base_url, keyless && clearLocalKey ? undefined : saved)
  if (!value && !keyless) throw new DesktopError('invalid_request', '请填写 API Key')
  return { ...input, base_url, model, value, dimensions: input.capability === 'embedding' ? input.dimensions ?? 0 : null }
}

function resolveKey(raw: string, provider: string, baseUrl: string, saved?: StoredModel) {
  let key: string
  try { key = normalizedApiKey(raw) } catch { throw new DesktopError('invalid_request', 'API Key 格式无效') }
  if (key || !saved || saved.provider !== provider || saved.base_url !== baseUrl) return key
  return saved.value
}

function summary({ value, ...model }: StoredModel): DesktopAuxiliaryModelSummary {
  return { ...model, has_value: Boolean(value) }
}

type ResolveProxy = NonNullable<Parameters<typeof createNodeProviderTransport>[0]>['resolveProxy']

function transport(baseUrl: string, resolveProxy: ResolveProxy) {
  const local = isLoopback(new URL(baseUrl))
  return createNodeProviderTransport({ ...desktopTransportOptions(local, resolveProxy), connectTimeoutMs: 8_000 })
}

async function testModel(model: DesktopAuxiliaryModelDraft, resolveProxy: ResolveProxy) {
  const probe = createByokCredentialTestProbe(process.env, {
    includeUpstreamDetail: false,
    createTransport: () => transport(model.base_url, resolveProxy),
  })
  const result = await probe({
    provider: model.provider, capability: model.capability, apiFormat: model.api_format,
    baseUrl: model.capability === 'embedding' && model.provider === 'ollama' && model.api_format === 'native'
      ? model.base_url.replace(/\/api$/, '') + '/v1' : model.base_url,
    model: model.model, dimensions: model.dimensions, apiKey: model.value,
  })
  return { ok: result.ok, message: ('message' in result ? result.message : undefined) ?? (result.ok ? '模型连接正常' : result.detail) }
}

function auxiliaryStore(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]) {
  return createEncryptedDesktopStore(directory, 'auxiliary-models', encryption, desktopAuxiliaryModelStorage.parse)
}

export function createDesktopEmbeddingResolver(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]) {
  const store = auxiliaryStore(directory, encryption)
  return async (): Promise<RagQueryEmbeddingSettings | undefined> => {
    const model = (await store.read())?.items.find(item => item.enabled && item.capability === 'embedding')
    if (!model) return undefined
    return { provider: model.provider, model: model.model, apiKey: model.value, dimensions: model.dimensions ?? 0,
      baseUrl: model.provider === 'ollama' && model.api_format === 'native' ? model.base_url.replace(/\/api$/, '') + '/v1' : model.base_url,
      allowLocal: ['local', 'ollama'].includes(model.provider) && isLoopback(new URL(model.base_url)) }
  }
}

/** 只由桌面宿主调用，语音密钥不经过渲染进程。 */
export function createDesktopVoiceTranscriber(
  directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  audio: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>, resolveProxy?: ResolveProxy,
) {
  const store = auxiliaryStore(directory, encryption)
  return async (media: AsrMedia, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const model = (await store.read())?.items.find(item => item.enabled && item.capability === 'speech_to_text')
    if (!model?.model.trim()) throw new DesktopError('model_unavailable', '请先启用语音模型')
    signal.throwIfAborted()
    const client = transport(model.base_url, resolveProxy)
    const config = {
      ...auxiliaryConfig(model), api_key: model.value,
      ...(model.api_format === 'dashscope' ? { dashscope_service: dashscopeAsrServiceForModel(model.model) } : {}),
    }
    const dependencies = { ...audio, transport: client, digest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      return model.api_format === 'minimax-asr'
        ? await transcribeMiniMax([media], config, dependencies, requestSignal, { raiseErrors: true })
        : await transcribeCompatibleAsr([media], config, dependencies, requestSignal, { raiseErrors: true })
    } catch {
      signal.throwIfAborted()
      throw new DesktopError('model_unavailable', '语音转写失败，请检查语音模型配置')
    } finally { await client.close() }
  }
}

/** IM 语音使用 Gateway 的统一选择、授权复核、ASR 与资源清理策略。 */
export function createDesktopImVoiceTranscriber(
  directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  audio: Pick<AsrDependencies, 'toWav' | 'probeAudioDuration'>, resolveProxy: ResolveProxy | undefined,
  diagnose: (code: 'im_voice_failed') => void,
) {
  const store = auxiliaryStore(directory, encryption)
  const ownerId = 'desktop-local'
  function revision(model: StoredModel | undefined) {
    return createHash('sha256').update(JSON.stringify(model ?? null)).digest('hex')
  }
  async function selectCurrent(signal: AbortSignal): Promise<ImVoiceSelection> {
    signal.throwIfAborted()
    const model = (await store.read())?.items.find(item => item.enabled && item.capability === 'speech_to_text')
    const candidate = model && model.model.trim() ? {
      ...auxiliaryConfig(model), api_key: model.value,
      ...(model.api_format === 'dashscope' ? { dashscope_service: dashscopeAsrServiceForModel(model.model) } : {}),
    } : null
    const configured = Boolean(candidate && supportsConfiguredVoiceModel(candidate))
    const profile = Object.freeze({ maxFileBytes: candidate?.api_format === 'minimax-asr'
      ? MINIMAX_ASR_MAX_FILE_BYTES : IM_VOICE_MAX_NATIVE_BYTES })
    const version = revision(model)
    return {
      ownerId, version, configured, config: configured && candidate ? Object.freeze(candidate) : null, profile,
      async authorizeCurrent() {
        const current = (await store.read())?.items.find(item => item.enabled && item.capability === 'speech_to_text')
        return revision(current) === version
      },
    }
  }
  return createImVoiceTranscriber({
    ownerId, voice: { select: (_ownerId, signal) => selectCurrent(signal) }, authorize: async () => true,
    createTransport: config => {
      const client = transport(config.base_url ?? '', resolveProxy)
      return { transport: client, close: () => client.close() }
    }, diagnose, audio, raiseErrors: true,
  })
}

export function auxiliaryModelHandlers(
  directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  resolveProxy?: ResolveProxy,
  onEmbeddingChanged?: () => Promise<unknown>,
): IpcHandlers {
  const store = auxiliaryStore(directory, encryption)
  const read = async () => await store.read() ?? { nextId: 1, items: [] }
  let writes: Promise<unknown> = Promise.resolve()
  function mutate(change: (state: Awaited<ReturnType<typeof read>>) => DesktopAuxiliaryModelResult) {
    const pending = writes.then(async () => {
      const state = await read()
      const activeEmbedding = () => JSON.stringify(state.items.find(item => item.enabled && item.capability === 'embedding') ?? null)
      const before = activeEmbedding()
      const result = change(state)
      await store.write(state)
      if (before !== activeEmbedding()) await onEmbeddingChanged?.().catch(() => {})
      return result
    })
    writes = pending.catch(() => {})
    return pending
  }
  function find(items: StoredModel[], id: number) {
    const model = items.find(item => item.id === id)
    if (!model) throw new DesktopError('invalid_request', '模型配置已不存在')
    return model
  }
  function enable(items: StoredModel[], model: StoredModel) {
    for (const entry of items) if (entry.capability === model.capability) entry.enabled = entry.id === model.id
  }

  return {
    [DESKTOP_CHANNELS.auxiliaryModel]: async value => {
      const parsed = desktopAuxiliaryModelCommand.safeParse(value)
      if (!parsed.success) throw new DesktopError('invalid_request', '模型配置操作无效')
      const command = parsed.data
      switch (command.action) {
        case 'list':
          return { enabled: true, items: (await read()).items.map(summary) }
        case 'create':
          return mutate(state => {
            const model = { ...normalizeDraft(command.input), id: state.nextId++, enabled: false }
            state.items.push(model)
            enable(state.items, model)
            return summary(model)
          })
        case 'update':
          return mutate(state => {
            const current = find(state.items, command.id)
            const { enabled, ...patch } = command.input
            const { id, enabled: _enabled, ...draft } = current
            const updated = normalizeDraft({ ...draft, ...patch, value: patch.value ?? '' }, current, patch.value === '')
            Object.assign(current, updated)
            if (enabled === true) enable(state.items, current)
            else if (enabled === false) current.enabled = false
            return summary(current)
          })
        case 'delete':
          return mutate(state => {
            find(state.items, command.id)
            state.items = state.items.filter(item => item.id !== command.id)
            return null
          })
        case 'test':
          return testModel(find((await read()).items, command.id), resolveProxy)
        case 'preview': {
          const { credential_id, ...draft } = command.input
          const saved = credential_id == null ? undefined : find((await read()).items, credential_id)
          return testModel(normalizeDraft(draft, saved?.capability === draft.capability ? saved : undefined), resolveProxy)
        }
        case 'models': {
          const { credential_id, api_key, ...input } = command.input
          const draft = { ...input, model: input.model ?? '' }
          const baseUrl = destination(draft)
          const saved = credential_id == null ? undefined : find((await read()).items, credential_id)
          const apiKey = resolveKey(api_key, draft.provider, baseUrl, saved)
          if (!apiKey && !isLoopback(new URL(baseUrl))) throw new DesktopError('invalid_request', '请填写 API Key 后再获取模型列表')
          const client = transport(baseUrl, resolveProxy)
          try {
            const dashscope = draft.provider === 'qwen' && draft.api_format === 'dashscope'
            const base_url = dashscope && new URL(baseUrl).origin === 'https://dashscope.aliyuncs.com'
              ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : baseUrl
            const config = { ...auxiliaryConfig(draft), ...(dashscope && { api_format: 'openai' }), base_url, api_key: apiKey }
            const rows = await listProviderModels(config, { transport: client, digest: data => createHash('sha256').update(JSON.stringify(data)).digest('hex') }, AbortSignal.timeout(8_000))
            return { models: [...new Set(rows.flatMap(row => {
              if (!row || typeof row !== 'object') return []
              const name = 'id' in row ? row.id : 'name' in row ? row.name : undefined
              return typeof name === 'string' && name.length > 0 && name.length <= 200 ? [name] : []
            }))].sort().slice(0, 500) }
          } catch {
            throw new DesktopError('model_unavailable', '无法获取 Provider 模型列表')
          } finally {
            await client.close()
          }
        }
      }
    },
  }
}
