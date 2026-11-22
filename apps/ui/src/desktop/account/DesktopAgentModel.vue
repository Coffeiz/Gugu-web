<script setup lang="ts">
import { i18n } from '@/i18n'
import ProfileByokPane from '@/components/common/profile/ProfileByokPane.vue'
import { hasDesktopAgentModelBridge, requestDesktopAgentModel } from './agent-model-transport'
import type { DesktopAgentMediaDimension, DesktopAgentModel, DesktopAgentModelEntry, DesktopAgentModelList } from '@gugu/core/desktop'

const { t } = i18n.global
const available = hasDesktopAgentModelBridge()
const rows = new Map<number, ReturnType<typeof toRow>>()
let nextId = 1

// 共用面板用数字索引表单；本地存储和聊天仍使用原来的 UUID。
function toRow(item: DesktopAgentModelEntry, list: DesktopAgentModelList, id: number) {
  const mode = item.thinkingMode ?? 'default'
  return {
    id, localId: item.id, capability: 'llm', provider: item.provider, model: item.model,
    api_format: item.apiFormat, base_url: item.baseUrl, has_value: true, enabled: item.id === list.defaultId,
    thinking: mode === 'default' ? null : mode === 'disabled' ? 'disabled' : 'adaptive',
    reasoning_persistence: item.reasoningPersistence ?? 'off',
    reasoning_effort: ['default', 'disabled', 'adaptive'].includes(mode) ? null : mode,
    max_tokens: item.maxTokens ?? null, context_tokens: item.contextTokens ?? null,
    local_runtime: item.localRuntime, ollama_mode: item.ollamaMode,
    web_search_enabled: item.webSearchEnabled ?? false,
    image: Boolean(item.image), video: Boolean(item.video), audio: Boolean(item.audio),
  }
}

function sync(list: DesktopAgentModelList) {
  const ids = new Map([...rows.values()].map(row => [row.localId, row.id]))
  rows.clear()
  for (const item of list.items) {
    const id = ids.get(item.id) ?? nextId++
    rows.set(id, toRow(item, list, id))
  }
  return { enabled: true, items: [...rows.values()] }
}

function rowFor(id: number) {
  const row = rows.get(id)
  if (!row) throw new Error('本机模型已不存在')
  return row
}

interface Draft {
  provider?: string
  model?: string
  api_format?: string
  base_url?: string
  value?: string
  api_key?: string
  max_tokens?: number | null
  context_tokens?: number | null
  reasoning_persistence?: DesktopAgentModel['reasoningPersistence']
  reasoning_effort?: string | null
  thinking?: string | null
  web_search_enabled?: boolean
  image?: boolean
  video?: boolean
  audio?: boolean
  local_runtime?: string
  ollama_mode?: string
  ollama_api_mode?: string
  credential_id?: number
}

function preset(input: Draft): DesktopAgentModel & { apiKey: string } {
  const { local_runtime, ollama_mode } = input
  if (local_runtime !== undefined && local_runtime !== 'llama.cpp' && local_runtime !== 'vllm' && local_runtime !== 'other')
    throw new Error('模型运行参数无效')
  if (ollama_mode !== undefined && ollama_mode !== 'local' && ollama_mode !== 'cloud')
    throw new Error('模型运行参数无效')
  return {
    provider: input.provider ?? '',
    model: input.model ?? '',
    apiFormat: input.api_format || (input.ollama_api_mode === 'native' ? 'native' : 'openai'),
    baseUrl: input.base_url ?? '',
    apiKey: input.value ?? input.api_key ?? '',
    maxTokens: input.max_tokens ?? undefined,
    contextTokens: input.context_tokens ?? undefined,
    reasoningPersistence: input.reasoning_persistence,
    thinkingMode: input.reasoning_effort ?? input.thinking ?? 'default',
    webSearchEnabled: input.web_search_enabled,
    image: input.image, video: input.video, audio: input.audio,
    localRuntime: local_runtime === 'llama.cpp' || local_runtime === 'vllm' || local_runtime === 'other' ? local_runtime : undefined,
    ollamaMode: ollama_mode === 'local' || ollama_mode === 'cloud' ? ollama_mode : undefined,
  }
}

function savedId(input: Draft) {
  return input.credential_id === undefined ? null : rowFor(input.credential_id).localId
}

function testPassed() {
  return { ok: true, status: 'ok', message: t('desktopAgentModel.passed') }
}

const deviceApi = {
  async list() {
    return sync(await requestDesktopAgentModel({ action: 'list' }))
  },
  async create(input: Draft) {
    return sync(await requestDesktopAgentModel({ action: 'put', id: null, preset: preset(input) }))
  },
  async update(id: number, input: Draft & { enabled?: boolean }) {
    const row = rowFor(id)
    const list = input.enabled === true
      ? await requestDesktopAgentModel({ action: 'set_default', id: row.localId })
      : await requestDesktopAgentModel({ action: 'put', id: row.localId, preset: preset({ ...row, ...input }) })
    sync(list)
    return rowFor(id)
  },
  async remove(id: number) {
    return sync(await requestDesktopAgentModel({ action: 'delete', id: rowFor(id).localId }))
  },
  async test(id: number) {
    await requestDesktopAgentModel({ action: 'test', id: rowFor(id).localId })
    return testPassed()
  },
  async testPreview(input: Draft) {
    await requestDesktopAgentModel({ action: 'test', id: savedId(input), preset: preset(input) })
    return testPassed()
  },
  async modelsPreview(input: Draft) {
    const models = await requestDesktopAgentModel({ action: 'models', id: savedId(input), preset: preset(input) })
    return { models }
  },
  async capabilities(input: Draft) {
    return requestDesktopAgentModel({ action: 'capabilities', model: preset(input) })
  },
  async mediaCapabilityProbe(input: Draft & { dim: DesktopAgentMediaDimension }) {
    const row = input.credential_id === undefined ? undefined : rowFor(input.credential_id)
    return requestDesktopAgentModel({ action: 'probe', id: row?.localId ?? null, preset: preset({ ...row, ...input }), dim: input.dim })
  },
}
</script>

<template>
  <ProfileByokPane v-if="available" capability="llm" :device-api="deviceApi" />
  <p v-else class="pm-field-hint">{{ t('desktopAgentModel.native') }}</p>
</template>
