<template>
      <Teleport to="body">
        <Transition name="admin-modal" appear @after-leave="$emit('after-close')">
        <div v-if="visible && draft" class="modal-mask" @mousedown="onMaskMouseDown" @click="onMaskClick">
          <div class="modal-box">
            <h4 class="modal-title">{{ isNew ? t('adminLlmUi.newPreset') : t('adminLlmUi.editPreset') }}</h4>

            <div class="modal-field">
              <label>{{ t('adminLlmUi.presetName') }}</label>
              <input v-model="draft.name" :placeholder="t('llmExtraUi.modelNamePlaceholder')" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>{{ t('adminLlmUi.provider') }}</label>
              <div class="provider-selection-row" :class="{ 'provider-selection-row--single': !childProviderOptions.length }">
                <ProviderSelect
                  :model-value="draft.provider"
                  :providers="providerOptions"
                  @update:model-value="$emit('set-provider', $event)"
                />
                <ProviderSelect
                  v-if="childProviderOptions.length"
                  :model-value="childSelection"
                  :providers="childProviderOptions"
                  :placeholder="t('llmExtraUi.childOption')"
                  @update:model-value="$emit('set-provider', `${draft.provider === 'glm-coding' ? 'glm' : draft.provider}|${$event}`)"
                />
              </div>
            </div>

            <InterfaceTypeSelect
              v-if="interfaceOptionsFor(draft).length"
              :label="t('adminLlmUi.interfaceFormat')"
              :model-value="interfaceValue(draft)"
              :options="interfaceOptionsFor(draft)"
              :hint="draft.provider === 'mimo' ? t('llmExtraUi.multimodalHint') : draft.provider === 'local' ? t('llmExtraUi.localApiFormatHint') : draft.provider === 'ollama' ? t('llmExtraUi.ollamaApiFormatHint') : undefined"
              @update:model-value="pickInterface(draft, String($event))"
            />

            <div class="modal-field">
              <label>{{ t('llmExtraUi.baseUrl') }}</label>
              <input v-model="draft.base_url" :placeholder="draft.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://…'" class="modal-input" />
              <div v-if="draft.provider === 'qwen'" class="modal-hint">
                {{ t('llmExtraUi.bailianHint', { url: draft.api_format === 'anthropic' ? 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/apps/anthropic' : 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }) }}
              </div>
            </div>

            <div class="modal-field">
              <label>{{ draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? t('llmExtraUi.apiKeyOptional') : t('llmExtraUi.apiKey') }}</label>
              <input v-model="draft.api_key" type="password" autocomplete="new-password"
                :placeholder="draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? t('llmExtraUi.localOllama') : t('llmExtraUi.keepUnchanged')" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>{{ t('adminLlmUi.modelName') }}</label>
              <ModelPicker v-model="draft.model" :models="modelOptions" :open="modelMenuOpen" :loading="modelLoading" :error="modelError" placeholder="qwen-max" @open="$emit('open-model-menu')" @fetch="$emit('fetch-model-list')" @close="$emit('close-model-menu')" @select="$emit('select-model', $event)" />
            </div>

            <div class="modal-field-row">
              <div class="modal-field">
                <label>{{ t('adminLlmUi.maxTokens') }}</label>
                <input v-model.number="draft.max_tokens" type="number" min="100" max="32000" step="100" class="modal-input" />
              </div>
              <div class="modal-field">
                <label>{{ t('adminLlmUi.contextTokens') }}</label>
                <input v-model.number="draft.context_tokens" type="number" min="500" max="200000" step="500" class="modal-input" />
              </div>
            </div>

            <div class="modal-field">
              <label>{{ t('profileByokUi.thinkingIntensity') }}</label>
              <AdminSelect :model-value="thinkingSelection(draft)" :options="thinkingOptions"
                :placeholder="t('profileByokUi.thinkingPlaceholder')"
                class="thinking-select" @update:model-value="pickThinking(draft, String($event))" />
              <div class="thinking-hint">
                {{ t('profileByokUi.genericThinkingHint') }}
              </div>
            </div>

            <div v-if="supportsReasoningPersistence(draft)" class="modal-field">
              <div class="setting-choice-row">
                <div class="setting-choice-row__copy">
                  <span class="setting-choice-row__title">{{ t('llmExtraUi.reasoningPersistence') }}</span>
                  <span class="thinking-hint">{{ t('llmExtraUi.reasoningPersistenceHint') }}</span>
                </div>
                <div class="setting-choice-row__options">
                  <button v-for="option in reasoningPersistenceOptions" :key="option.key" type="button" class="toggle-btn"
                    :class="{ active: (draft.reasoning_persistence || 'off') === option.key }"
                    @click="draft.reasoning_persistence = option.key">{{ option.label }}</button>
                </div>
              </div>
            </div>

            <div v-if="draft.provider === 'deepseek'" class="modal-field">
              <div class="setting-choice-row">
                <div class="setting-choice-row__copy">
                  <span class="setting-choice-row__title">{{ t('llmExtraUi.imageDetail') }}</span>
                  <span class="thinking-hint">{{ t('llmExtraUi.imageDetailHint') }}</span>
                </div>
                <div class="setting-choice-row__options">
                  <button v-for="detail in imageDetailLevels" :key="detail.key" type="button" class="toggle-btn"
                    :class="{ active: (draft.image_detail || 'auto') === detail.key }"
                    @click="draft.image_detail = detail.key">{{ detail.label }}</button>
                </div>
              </div>
            </div>

            <div v-if="draft.provider === 'local'" class="modal-field">
              <div class="capability-heading">
                <div class="thinking-label">
                  <span>{{ t('llmExtraUi.localCapabilities') }}</span>
                  <span class="thinking-hint">{{ t('llmExtraUi.localCapabilitiesHint') }}</span>
                </div>
                <button type="button" class="capability-probe" :disabled="isNew || capabilityLoading"
                  @click="$emit('probe-capabilities', String(draft.id || ''))">
                  {{ capabilityLoading ? t('llmExtraUi.probing') : t('llmExtraUi.probe') }}
                </button>
              </div>
              <LocalCapabilityOverrides
                :model="draft"
                :checked-at="draft.capability_checked_at"
                :results="capabilityResults"
                @toggle="forwardCapabilityOverride"
              />
            </div>

            <div v-if="providerWebSearchAvailable(draft)" class="modal-field">
              <div class="setting-choice-row">
                <div class="setting-choice-row__copy">
                  <span class="setting-choice-row__title">{{ t('llmExtraUi.webSearch') }}</span>
                  <span class="thinking-hint">{{ draft.provider === 'minimax' ? t('llmExtraUi.minimaxWebSearchHint') : t('llmExtraUi.webSearchHint') }}</span>
                </div>
                <div class="setting-choice-row__options">
                  <ToggleSwitch :model-value="draft.web_search_enabled"
                    :aria-label="t('llmExtraUi.webSearch')"
                    @update:model-value="draft.web_search_enabled = $event" />
                </div>
              </div>
            </div>
            <MultimodalCapabilities :model="draft" :dims="mediaDimensions" variant="admin" :probing="probingDim" :probe-label="t('adminLlmUi.detect')" :probing-label="t('adminLlmUi.detecting')" :title="t('adminLlmUi.capabilities')" :hint="t('llmExtraUi.multimodalHint')" @probe="$emit('probe-media', draft.id, $event)" />
            <div v-if="probeFeedback" class="llm-msg" :class="{ 'llm-msg--error': probeFeedback.isError }" role="status">{{ probeFeedback.text }}</div>
            <div class="modal-actions">
              <span class="save-hint" :class="{ error: !!error }">{{ error }}</span>
              <button class="btn-ghost" @click="$emit('close')">{{ t('adminLlmUi.cancel') }}</button>
              <button class="btn-primary" :disabled="saving" @click="$emit('save')">
                <svg v-if="saving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
                {{ saving ? t('adminLlmUi.saving') : t('adminLlmUi.save') }}
              </button>
            </div>
          </div>
        </div>
        </Transition>
      </Teleport>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import ProviderSelect from '../../components/ProviderSelect.vue'
import InterfaceTypeSelect from '../../components/InterfaceTypeSelect.vue'
import { apiFormatsFromSnapshot, defaultApiFormatFromSnapshot, defaultApiFormatForProvider, defaultBaseUrlFromSnapshot, retainApiFormatFromSnapshot, type ProviderApiFormatSnapshot } from '@/utils/modelProviders'
import LocalCapabilityOverrides from '../../components/LocalCapabilityOverrides.vue'
import MultimodalCapabilities from '@/components/common/controls/MultimodalCapabilities.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import ModelPicker from '@/components/common/models/ModelPicker.vue'
import { buildThinkingOptionsForIdentity } from '@/utils/llmThinkingOptions'
import { providerWebSearchAvailable } from '@/utils/providerWebSearch'

interface Provider { key: string; label: string; base_url: string; model: string }
interface Option { key: string; label: string; hint?: string }
interface LlmPresetDraft {
  id?: string | number; name: string; provider: string; api_key: string; base_url: string; model: string
  max_tokens: number; context_tokens: number; thinking: string; reasoning_persistence: 'off' | 'continuation'; web_search_enabled: boolean
  image: boolean; video: boolean; audio: boolean
  capability_checked_at?: string
  [key: string]: unknown
}

const props = defineProps<{
  probeFeedback: { text: string; isError: boolean } | null
  draft: LlmPresetDraft | null; visible: boolean; isNew: boolean; saving: boolean; error: string
  providers: Provider[]; imageDetailLevels: Option[]; mediaDimensions: Option[]
  capabilityLoading: boolean; capabilityResults: Record<string, { status?: string; detail?: string }>; modelLoading: boolean; modelError: string
  modelMenuOpen: boolean; modelOptions: string[]; probingDim: string | null
}>()
const { t } = useI18n()
const adminStore = useAdminStore()
const capabilitySnapshot = ref<Record<string, any> | null>(null)
const capabilitySnapshotKey = ref('')
const capabilitySnapshotIdentity = ref('')
let capabilityRequestId = 0
function capabilityKeyFor(draft: LlmPresetDraft | null) {
  return draft
    ? [draft.provider, draft.model, draft.api_format, draft.base_url, draft.ollama_api_mode, draft.ollama_mode, draft.local_runtime].join('|')
    : ''
}
function capabilityIdentityFor(draft: LlmPresetDraft | null) {
  return draft
    ? [draft.provider, draft.model, draft.ollama_api_mode, draft.ollama_mode, draft.local_runtime].join('|')
    : ''
}
const providerGroups = computed(() => props.providers.map(provider => ({
  ...provider,
  children: provider.key === 'glm'
    ? [{ key: 'general', label: t('adminAgentUi.generalApi') }, { key: 'coding', label: t('adminAgentUi.codingPlan') }]
    : provider.key === 'local'
      ? [{ key: 'llama.cpp', label: 'llama.cpp' }, { key: 'vllm', label: 'vLLM' }, { key: 'other', label: t('adminAgentUi.otherCompatible') }]
      : provider.key === 'ollama'
        ? [{ key: 'local', label: t('adminAgentUi.localOllama') }, { key: 'cloud', label: 'Ollama Cloud' }]
      : undefined,
})))
const providerOptions = computed(() => providerGroups.value.map(({ children: _children, ...provider }) => provider))
const providerSelection = computed(() => {
  const draft = props.draft
  if (!draft) return ''
  if (draft.provider === 'glm-coding') return 'glm|coding'
  if (draft.provider === 'glm') return `glm|${(draft.base_url || '').includes('/api/coding/') ? 'coding' : 'general'}`
  if (draft.provider === 'local') return `local|${draft.local_runtime || 'other'}`
  if (draft.provider === 'ollama') return `ollama|${draft.ollama_mode || 'local'}`
  return draft.provider
})
const childSelection = computed(() => providerSelection.value.split('|')[1] || '')
const childProviderOptions = computed(() => {
  const providerKey = props.draft?.provider === 'glm-coding' ? 'glm' : props.draft?.provider
  const provider = providerGroups.value.find(item => item.key === providerKey)
  return (provider?.children || []).map(child => ({ key: child.key, label: child.label }))
})
const formatLabels: Record<string, string> = {
  openai: 'adminAgentUi.formatOpenai', responses: 'adminAgentUi.formatResponses',
  anthropic: 'adminAgentUi.formatAnthropic', native: 'adminAgentUi.ollamaNative',
}
function interfaceOptionsFor(draft: LlmPresetDraft | null) {
  if (!draft) return []
  // API 格式选项属于当前 Provider；切换模型时继续展示上一份同供应商声明，
  // 避免每次输入都因能力快照刷新而卸载整个选择器。模型能力仍按 identity 单独校验。
  const snapshot = capabilitySnapshot.value?.provider === draft.provider
    ? capabilitySnapshot.value as ProviderApiFormatSnapshot | null
    : null
  const supported = apiFormatsFromSnapshot(snapshot, draft.provider)
  const options = supported.map(key => ({ key, label: t(formatLabels[key] || key) }))
  return draft.provider === 'ollama' && !options.some(option => option.key === 'native')
    ? [{ key: 'native', label: t(formatLabels.native) }, ...options]
    : options
}
function interfaceValue(draft: LlmPresetDraft) {
  const snapshot = capabilitySnapshotIdentity.value === capabilityIdentityFor(draft)
    ? capabilitySnapshot.value as ProviderApiFormatSnapshot | null
    : null
  return String(draft.api_format || defaultApiFormatFromSnapshot(snapshot, draft.provider) || (draft.provider === 'ollama' && (draft.ollama_api_mode || 'native') === 'native' ? 'native' : defaultApiFormatForProvider(draft.provider)))
}
function supportsReasoningPersistence(draft: LlmPresetDraft | null) {
  if (!draft) return false
  const format = interfaceValue(draft)
  if (draft.provider === 'ollama' && format === 'native') return false
  // 推理状态能力由 wire 协议决定；Chat Completions 不支持跨请求状态持久化。
  return format === 'responses' || format === 'anthropic'
}
function pickInterface(draft: LlmPresetDraft, value: string) {
  if (draft.provider === 'ollama') {
    draft.ollama_api_mode = value === 'native' ? 'native' : 'openai'
    draft.api_format = value === 'native' ? '' : value
    if (value === 'native' || value === 'openai') draft.reasoning_persistence = 'off'
    return
  }
  draft.api_format = value
  if (value === 'openai') draft.reasoning_persistence = 'off'
  $emit('pick-api-format', value)
}
const thinkingOptions = computed(() => {
  const draft = props.draft
  return buildThinkingOptionsForIdentity(
    capabilitySnapshot.value,
    capabilitySnapshotIdentity.value,
    draft ? capabilityIdentityFor(draft) : '',
    t,
  )
})
function thinkingSelection(draft: LlmPresetDraft) {
  if (!draft.thinking) return 'default'
  if (capabilitySnapshot.value?.generic_thinking_toggle_supported === true) return String(draft.thinking)
  return draft.thinking === 'adaptive' && draft.reasoning_effort
    ? String(draft.reasoning_effort)
    : String(draft.thinking)
}
function pickThinking(draft: LlmPresetDraft, value: string) {
  if (value === 'default') { draft.thinking = ''; draft.reasoning_effort = ''; return }
  if (value === 'disabled') { draft.thinking = 'disabled'; draft.reasoning_effort = ''; return }
  draft.thinking = 'adaptive'
  draft.reasoning_effort = value === 'adaptive' ? '' : value
}
watch(
  () => {
    return capabilityKeyFor(props.draft)
  },
  async (key) => {
    const draft = props.draft
    const requestId = ++capabilityRequestId
    const previousSnapshot = capabilitySnapshot.value
    if (capabilitySnapshot.value?.provider !== draft?.provider) {
      capabilitySnapshot.value = null
      capabilitySnapshotIdentity.value = ''
    }
    capabilitySnapshotKey.value = ''
    if (!draft || !draft.provider) return
    try {
      const response = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/capabilities-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: draft.provider, api_format: draft.api_format || '', base_url: draft.base_url || '', model: draft.model || '', ollama_api_mode: draft.ollama_api_mode || 'native', ollama_mode: draft.ollama_mode || 'local', local_runtime: draft.local_runtime || 'other' }),
      })
      if (!response.ok) throw new Error('能力信息加载失败')
      const snapshot = await response.json()
      const latest = props.draft
      if (requestId !== capabilityRequestId || !latest || key !== [latest.provider, latest.model, latest.api_format, latest.base_url, latest.ollama_api_mode, latest.ollama_mode, latest.local_runtime].join('|')) return
      capabilitySnapshot.value = snapshot
      capabilitySnapshotIdentity.value = capabilityIdentityFor(latest)
      capabilitySnapshotKey.value = capabilityKeyFor(latest)
      const defaultFormat = defaultApiFormatFromSnapshot(snapshot, latest.provider)
      const selectedFormat = String(latest.api_format || defaultFormat)
      const retainedFormat = retainApiFormatFromSnapshot(snapshot, latest.provider, selectedFormat)
      if (latest.api_format && retainedFormat !== latest.api_format) {
        latest.api_format = retainedFormat
        if (latest.provider === 'ollama') latest.ollama_api_mode = retainedFormat === 'native' ? 'native' : 'openai'
      }
      const defaultUrls = [
        ...Object.values((snapshot.default_base_urls || {}) as Record<string, string>),
        ...Object.values(((previousSnapshot?.default_base_urls || {}) as Record<string, string>)),
        previousSnapshot?.default_base_url || '',
      ]
      if (!latest.base_url || defaultUrls.includes(latest.base_url)) {
        const defaultUrl = defaultBaseUrlFromSnapshot(snapshot, retainedFormat)
        if (defaultUrl) latest.base_url = defaultUrl
      }
      if (!thinkingOptions.value.some(option => option.value === thinkingSelection(latest))) pickThinking(latest, 'default')
    } catch {
      if (requestId === capabilityRequestId && props.draft) pickThinking(props.draft, 'default')
    }
  },
  { immediate: true },
)
const reasoningPersistenceOptions = computed(() => [
  { key: 'off', label: t('llmExtraUi.reasoningOff') },
  { key: 'continuation', label: t('llmExtraUi.reasoningContinuation') },
] as const)
const $emit = defineEmits<{
  (event: 'close'): void; (event: 'after-close'): void; (event: 'save'): void; (event: 'set-provider', key: string): void; (event: 'open-model-menu'): void; (event: 'close-model-menu'): void
  (event: 'fetch-model-list'): void; (event: 'select-model', model: string): void; (event: 'pick-api-format', format: string): void
  (event: 'set-capability-override', key: string, enabled: boolean): void; (event: 'probe-capabilities', id: string): void; (event: 'probe-media', id: string | number | undefined, dim: string): void
}>()
watch(
  () => props.draft && `${props.draft.provider}|${interfaceValue(props.draft)}`,
  () => {
    if (props.draft && !supportsReasoningPersistence(props.draft)) {
      props.draft.reasoning_persistence = 'off'
    }
  },
  { immediate: true },
)
// 拖选文本时在弹窗外松开会把 click 派发到按下/释放目标的公共祖先（即遮罩），
// 单看 click.self 会误关；只有按下也从遮罩开始才视为点外关闭。
let maskPressStarted = false
function onMaskMouseDown(event: MouseEvent) {
  maskPressStarted = event.target === event.currentTarget
}
function onMaskClick(event: MouseEvent) {
  if (maskPressStarted && event.target === event.currentTarget) $emit('close')
  maskPressStarted = false
}
function forwardCapabilityOverride(key: string, enabled: boolean) {
  $emit('set-capability-override', key, enabled)
}
</script>

<style scoped src="../../components/model-preset-editor.css"></style>
