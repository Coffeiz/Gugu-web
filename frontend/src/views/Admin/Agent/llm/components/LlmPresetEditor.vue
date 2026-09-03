<template>
      <Teleport to="body">
        <Transition name="admin-modal" appear @after-leave="$emit('after-close')">
        <div v-if="visible && draft" class="modal-mask" @click.self="$emit('close')">
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
                  @update:model-value="$emit('set-provider', `${draft.provider}|${$event}`)"
                />
              </div>
            </div>

            <InterfaceTypeSelect
              v-if="draft.provider === 'mimo'"
              :label="t('adminLlmUi.interfaceFormat')"
              :model-value="String(draft.api_format || 'openai')"
              :options="apiFormats"
              :hint="t('llmExtraUi.multimodalHint')"
              @update:model-value="$emit('pick-api-format', String($event))"
            />
            <InterfaceTypeSelect
              v-else-if="draft.provider === 'ollama'"
              :label="t('adminLlmUi.interfaceFormat')"
              :model-value="String(draft.ollama_api_mode || 'native')"
              :options="ollamaInterfaceOptions"
              @update:model-value="draft.ollama_api_mode = String($event)"
            />

            <div class="modal-field">
              <label>{{ t('llmExtraUi.baseUrl') }}</label>
              <input v-model="draft.base_url" :placeholder="draft.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://…'" class="modal-input" />
              <div v-if="draft.provider === 'qwen'" class="modal-hint">
                {{ t('llmExtraUi.bailianHint', { url: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }) }}
              </div>
            </div>

            <div class="modal-field">
              <label>{{ draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? t('llmExtraUi.apiKeyOptional') : t('llmExtraUi.apiKey') }}</label>
              <input v-model="draft.api_key" type="password" autocomplete="new-password"
                :placeholder="draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? t('llmExtraUi.localOllama') : t('llmExtraUi.keepUnchanged')" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>{{ t('adminLlmUi.modelName') }}</label>
              <div class="model-picker" @focusout="$emit('close-model-menu')">
                <div class="model-picker-row">
                  <input v-model="draft.model" placeholder="qwen-max" class="modal-input"
                    @focus="$emit('open-model-menu')" />
                  <button type="button" class="model-fetch-btn" :disabled="modelLoading"
                    :title="t('llmExtraUi.fetchModelsTitle')"
                    @mousedown.prevent @click="$emit('fetch-model-list')">
                    {{ modelLoading ? t('adminLlmUi.gettingModels') : t('adminLlmUi.getModels') }}
                  </button>
                </div>
                <div v-if="modelMenuOpen" class="model-options" @mousedown.stop>
                  <div v-if="modelError" class="model-option-hint error">{{ modelError }}</div>
                  <div v-else-if="!modelOptions.length" class="model-option-hint">
                    {{ t('llmExtraUi.fetchModelsHint') }}
                  </div>
                  <button v-for="model in filteredModels" :key="model" type="button" class="model-option"
                    @mousedown.prevent="$emit('select-model', model)">{{ model }}</button>
                </div>
              </div>
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

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>{{ t('adminLlmUi.deepThinking') }}</span>
                <span class="thinking-hint">{{ t('llmExtraUi.thinkingHint') }}</span>
              </div>
              <ToggleSwitch :model-value="draft.thinking === 'adaptive'" :aria-label="t('llmExtraUi.toggleThinking')" @update:model-value="draft.thinking = $event ? 'adaptive' : 'disabled'" />
            </div>

            <div class="modal-field modal-field--row" v-if="draft.provider === 'deepseek'">
              <div class="thinking-label">
                <span>{{ t('llmExtraUi.effort') }}</span>
                <span class="thinking-hint">{{ t('llmExtraUi.effortHint') }}</span>
              </div>
              <div class="option-button-row">
                <button v-for="effort in deepseekEfforts" :key="effort.key" type="button" class="toggle-btn"
                  :class="{ active: draft.reasoning_effort === effort.key || (!draft.reasoning_effort && effort.key === '') }"
                  @click="draft.reasoning_effort = effort.key">{{ effort.label }}</button>
              </div>
            </div>

            <div class="modal-field modal-field--row" v-if="draft.provider === 'deepseek'">
              <div class="thinking-label">
                <span>{{ t('llmExtraUi.imageDetail') }}</span>
                <span class="thinking-hint">{{ t('llmExtraUi.imageDetailHint') }}</span>
              </div>
              <div class="option-button-row">
                <button v-for="detail in imageDetailLevels" :key="detail.key" type="button" class="toggle-btn"
                  :class="{ active: (draft.vision_detail || 'auto') === detail.key }"
                  @click="draft.vision_detail = detail.key">{{ detail.label }}</button>
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

            <MultimodalCapabilities :model="draft" :dims="visionDims" variant="admin" :probing="probingDim" :probe-label="t('adminLlmUi.detect')" :probing-label="t('adminLlmUi.detecting')" :title="t('adminLlmUi.capabilities')" :hint="t('llmExtraUi.multimodalHint')" @probe="$emit('probe-vision', draft.id, $event)" />
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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ProviderSelect from '../../components/ProviderSelect.vue'
import InterfaceTypeSelect from '../../components/InterfaceTypeSelect.vue'
import LocalCapabilityOverrides from '../../components/LocalCapabilityOverrides.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import MultimodalCapabilities from '@/components/common/controls/MultimodalCapabilities.vue'

interface Provider { key: string; label: string; base_url: string; model: string }
interface Option { key: string; label: string; hint?: string }
interface LlmPresetDraft {
  id?: string | number; name: string; provider: string; api_key: string; base_url: string; model: string
  max_tokens: number; context_tokens: number; thinking: string
  vision: boolean; vision_video: boolean; vision_audio: boolean
  capability_checked_at?: string
  [key: string]: unknown
}
const props = defineProps<{
  draft: LlmPresetDraft | null; visible: boolean; isNew: boolean; saving: boolean; error: string
  providers: Provider[]; apiFormats: Option[]; deepseekEfforts: Option[]; imageDetailLevels: Option[]; visionDims: Option[]
  capabilityLoading: boolean; capabilityResults: Record<string, { status?: string; detail?: string }>; modelLoading: boolean; modelError: string
  modelMenuOpen: boolean; modelOptions: string[]; filteredModels: string[]; probingDim: string | null
}>()
const { t } = useI18n()
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
  if (draft.provider === 'glm') return `glm|${(draft.base_url || '').includes('/api/coding/') ? 'coding' : 'general'}`
  if (draft.provider === 'local') return `local|${draft.local_runtime || 'other'}`
  if (draft.provider === 'ollama') return `ollama|${draft.ollama_mode || 'local'}`
  return draft.provider
})
const childSelection = computed(() => providerSelection.value.split('|')[1] || '')
const childProviderOptions = computed(() => {
  const provider = providerGroups.value.find(item => item.key === props.draft?.provider)
  return (provider?.children || []).map(child => ({ key: child.key, label: child.label }))
})
const ollamaInterfaceOptions = [
  { key: 'native', label: t('adminAgentUi.ollamaNative') },
  { key: 'openai', label: t('adminAgentUi.providerOpenai') },
]
const $emit = defineEmits<{
  (event: 'close'): void; (event: 'after-close'): void; (event: 'save'): void; (event: 'set-provider', key: string): void; (event: 'open-model-menu'): void
  (event: 'close-model-menu'): void; (event: 'fetch-model-list'): void; (event: 'select-model', model: string): void; (event: 'pick-api-format', format: string): void
  (event: 'set-capability-override', key: string, enabled: boolean): void; (event: 'probe-capabilities', id: string): void; (event: 'probe-vision', id: string | number | undefined, dim: string): void
}>()
function forwardCapabilityOverride(key: string, enabled: boolean) {
  $emit('set-capability-override', key, enabled)
}
</script>

<style scoped>
/* 弹窗样式沿用 Agent Admin 控件规范，弹窗自身不再由页面入口承载。 */
.modal-mask { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(4,5,12,.58); backdrop-filter:blur(8px); }
.modal-box { width:min(620px,100%); max-height:calc(100vh - 40px); box-sizing:border-box; overflow-x:hidden; overflow-y:auto; scrollbar-gutter:stable; padding:22px 24px; border:1px solid rgba(255,255,255,.1); border-radius:16px; background:rgba(20,22,38,.96); box-shadow:0 8px 36px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.06); color:rgba(255,255,255,.82); }
.modal-title { margin:0 0 14px; color:rgba(255,255,255,.88); font-size:16px; font-weight:700; }
.modal-field { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }.modal-field label { color:rgba(255,255,255,.4); font-size:11px; font-weight:600; }.modal-input { width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.78); font-size:13px; outline:none; }.modal-input:focus { border-color:rgba(123,127,178,.45); }.modal-hint,.thinking-hint { color:rgba(255,255,255,.38); font-size:11px; line-height:1.5; }.toggle-group,.api-format-grid { display:flex; flex-wrap:wrap; gap:6px; }.toggle-btn { padding:6px 12px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.05); color:rgba(255,255,255,.48); font-size:12px; cursor:pointer; }.toggle-btn.active { border-color:rgba(123,127,178,.35); background:rgba(123,127,178,.2); color:rgba(255,255,255,.88); }.modal-field-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.modal-field--row { flex-direction:row; align-items:center; justify-content:space-between; }.thinking-label { display:flex; flex-direction:column; gap:3px; }.model-picker { position:relative; }.model-picker-row { display:flex; gap:6px; }.model-picker-row .modal-input { flex:1; }.model-fetch-btn,.pca-btn { padding:6px 10px; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.58); font-size:12px; cursor:pointer; }.model-fetch-btn:disabled,.pca-btn:disabled { opacity:.5; cursor:default; }.model-options { position:absolute; z-index:2; top:calc(100% + 4px); left:0; right:0; max-height:180px; overflow:auto; padding:4px; border:1px solid rgba(255,255,255,.11); border-radius:10px; background:rgba(20,22,38,.98); }.model-option { display:block; width:100%; padding:7px 9px; border:0; border-radius:6px; background:transparent; color:rgba(255,255,255,.7); text-align:left; cursor:pointer; }.model-option:hover { background:rgba(255,255,255,.07); }.model-option-hint { padding:7px 9px; color:rgba(255,255,255,.35); font-size:11px; }.model-option-hint.error { color:#e07878; }.modal-actions { display:flex; align-items:center; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid rgba(255,255,255,.07); }.save-hint { flex:1; color:#5ab899; font-size:12px; }.save-hint.error { color:#e07878; }.btn-ghost,.btn-primary { padding:6px 14px; border-radius:9px; font-size:13px; cursor:pointer; }.btn-ghost { border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.06); color:rgba(255,255,255,.55); }.btn-primary { border:0; background:linear-gradient(135deg,#7b7fb2,#9590c4); color:#fff; font-weight:600; }.btn-primary:disabled,.btn-ghost:disabled { opacity:.5; cursor:default; }
.provider-selection-row { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:6px; }
.provider-selection-row--single { grid-template-columns:1fr; }
.provider-selection-row .provider-select { min-width:0; width:100%; }
.modal-input::placeholder { color: rgba(255,255,255,.2); }
.modal-input { border-color:var(--input-border); background:var(--input-bg); color:var(--input-fg); box-shadow:var(--input-hover-shadow), 0 0 0 0 transparent; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.modal-input:hover:not(:disabled) { background:var(--input-bg-hover); border-color:var(--input-border-hover); }
.modal-input:focus:not(:disabled) { background:var(--input-bg-focus); border-color:var(--input-border-focus); box-shadow:var(--input-hover-shadow), var(--input-focus-shadow); }.number-input{width:96px;text-align:center}
.modal-input::placeholder { color:var(--input-placeholder); opacity:.82; }
.modal-field label { color: rgba(255,255,255,.35); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
.modal-hint code { color: rgba(123,127,178,.9); background: rgba(123,127,178,.12); padding: 1px 5px; border-radius: 4px; font-size: 10.5px; word-break: break-all; }
.modal-field-row { margin-bottom: 10px; }
.modal-field-row .modal-field { margin-bottom: 0; }
.capability-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; }
.capability-probe { display:inline-flex; align-items:center; justify-content:center; min-height:28px; padding:5px 11px; border:1px solid rgba(123,127,178,.34); border-radius:7px; background:rgba(123,127,178,.09); color:#9590c4; font:inherit; font-size:11px; line-height:16px; cursor:pointer; transition:background .12s ease,border-color .12s ease,color .12s ease,transform .12s ease; }
.capability-probe:hover:not(:disabled) { border-color:#8e92c8; background:rgba(123,127,178,.15); color:#aaa6d4; }
.capability-probe:active:not(:disabled) { transform:translateY(1px) scale(.985); }
.capability-probe:disabled { opacity:.5; cursor:default; }
.modal-field--row > span { font-size: 11px; font-weight: 600; color: rgba(255,255,255,.35); letter-spacing: .07em; }
.thinking-label > span:first-child { font-size: 11px; font-weight: 600; color: rgba(255,255,255,.35); text-transform: uppercase; letter-spacing: .07em; }
.thinking-hint { color: rgba(255,255,255,.2); text-transform: none; letter-spacing: 0; font-weight: 400; }
.option-button-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.option-button-row .toggle-btn { min-height:28px; padding:4px 10px; }
.option-button-row--center { justify-content:flex-end; }
.toggle-btn { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.model-fetch-btn, .pca-btn { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.btn-ghost, .btn-primary { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; }
@media(max-width:720px){ .modal-field-row { grid-template-columns:1fr; gap:0; } .modal-box { padding:18px; } }
</style>
<style scoped>
.btn-primary { background: var(--action-primary-bg); color: var(--content-on-accent); transition: background-color .15s; }
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
</style>
