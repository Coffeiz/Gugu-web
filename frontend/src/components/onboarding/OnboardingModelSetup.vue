<template>
  <div class="model-setup">
    <button
      v-if="!expanded"
      type="button"
      class="model-card-summary"
      :class="{ configured: Boolean(item) }"
      @click="openEditor"
    >
      <span class="model-card-icon"><Icon name="user.security" size="sm" /></span>
      <span class="model-card-copy">
        <b>{{ item ? providerLabel(item.provider) : t('profileByokUi.generalModel') }}</b>
        <small>{{ item?.model || t('profileByokUi.notConfigured') }}</small>
      </span>
      <span class="model-card-state">{{ item ? t('profileByokUi.edit') : '+' }}</span>
    </button>

    <div v-else class="model-card-editor">
      <div class="model-editor-head">
        <div>
          <b>{{ t('profileByokUi.generalModel') }}</b>
          <small>{{ item ? t('profileByokUi.editTitle') : t('profileByokUi.addModel') }}</small>
        </div>
        <button type="button" class="model-editor-close" :aria-label="t('common.actions.close')" @click="expanded = false">×</button>
      </div>

      <div class="model-fields">
        <label class="model-field">
          <span>{{ t('profileByokUi.provider') }}</span>
          <ProviderSelect
            :model-value="draft.provider"
            :providers="providerOptions"
            @update:model-value="applyProvider"
          />
        </label>

        <label class="model-field">
          <span>{{ t('profileByokUi.apiKey') }}</span>
          <input
            v-model="draft.value"
            class="form-input"
            type="password"
            autocomplete="new-password"
            :placeholder="item ? t('profileByokUi.apiKeyKeep') : t('profileByokUi.apiKey')"
          />
        </label>

        <label class="model-field">
          <span>{{ t('profileByokUi.baseUrlOptional') }}</span>
          <input v-model="draft.base_url" class="form-input" :placeholder="t('profileByokUi.baseUrlOptional')" />
        </label>

        <label class="model-field model-field-wide">
          <span>{{ t('profileByokUi.generalModel') }}</span>
          <div ref="modelPickerRef" class="model-picker-row">
            <input v-model="draft.model" class="form-input" :placeholder="t('profileByokUi.modelOptional')" />
            <ActionButton variant="secondary" fit :disabled="modelLoading || !draft.provider" @click="fetchModels">
              {{ modelLoading ? '…' : t('profileByokUi.getModels') }}
            </ActionButton>
          </div>
          <PopupMenu :show="modelMenuOpen" :anchor="modelPickerRef" popup-class="onboarding-model-options">
            <div v-if="modelError" class="model-option-hint err">{{ modelError }}</div>
            <div v-else-if="!modelOptions.length" class="model-option-hint">{{ t('profileByokUi.noModels') }}</div>
            <button v-for="model in modelOptions" :key="model" type="button" class="model-option" @click="selectModel(model)">{{ model }}</button>
          </PopupMenu>
        </label>
      </div>

      <div class="model-editor-actions">
        <span class="model-feedback" :class="feedbackType">{{ feedback }}</span>
        <ActionButton v-if="item" variant="secondary" fit :disabled="testing || saving" @click="testConnection">
          {{ testing ? '…' : t('profileByokUi.test') }}
        </ActionButton>
        <ActionButton fit :disabled="saving || !canSave" @click="save">
          {{ saving ? '…' : t('profileByokUi.saveConfig') }}
        </ActionButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/ActionButton.vue'
import Icon from '@/components/common/Icon.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'
import ProviderSelect from '@/views/Admin/Agent/components/ProviderSelect.vue'
import { byokApi } from '@/services/api'
import { MODEL_PROVIDERS } from '@/utils/modelProviders'

type Item = {
  id: number
  capability: string
  provider: string
  api_format: string
  base_url: string
  model: string
  has_value: boolean
  enabled: boolean
}

type Draft = {
  provider: string
  value: string
  api_format: string
  base_url: string
  model: string
}

const { t } = useI18n()
const expanded = ref(false)
const item = ref<Item | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const feedback = ref('')
const feedbackType = ref<'ok' | 'err' | ''>('')
const modelLoading = ref(false)
const modelError = ref('')
const modelOptions = ref<string[]>([])
const modelMenuOpen = ref(false)
const modelPickerRef = ref<HTMLElement | null>(null)

const draft = reactive<Draft>({ provider: '', value: '', api_format: '', base_url: '', model: '' })
const providerOptions = computed(() => MODEL_PROVIDERS.map(provider => ({ key: provider.value, label: t(provider.labelKey) })))
const canSave = computed(() => Boolean(draft.provider && draft.model && (item.value || draft.value || keyOptional.value)))
const keyOptional = computed(() => draft.provider === 'local' || (draft.provider === 'ollama' && !/ollama\.com/i.test(draft.base_url)))

function providerLabel(value: string) {
  const provider = MODEL_PROVIDERS.find(entry => entry.value === value)
  return provider ? t(provider.labelKey) : value
}

function syncDraft(source: Item | null) {
  draft.provider = source?.provider || ''
  draft.value = ''
  draft.api_format = source?.api_format || ''
  draft.base_url = source?.base_url || ''
  draft.model = source?.model || ''
  modelOptions.value = []
  modelError.value = ''
  modelMenuOpen.value = false
  feedback.value = ''
  feedbackType.value = ''
}

async function load() {
  loading.value = true
  try {
    const result = await byokApi.list()
    const llmItems = (result.items || []).filter((entry: any) => entry.capability === 'llm') as Item[]
    item.value = llmItems.find(entry => entry.enabled) || llmItems[0] || null
    syncDraft(item.value)
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : 'BYOK 加载失败'
    feedbackType.value = 'err'
  } finally {
    loading.value = false
  }
}

function openEditor() {
  if (loading.value) return
  syncDraft(item.value)
  expanded.value = true
}

function applyProvider(value: string) {
  draft.provider = value
  const provider = MODEL_PROVIDERS.find(entry => entry.value === value)
  if (!provider) return
  draft.base_url = provider.base_url
  draft.model = provider.model
  draft.api_format = value === 'mimo' ? 'openai' : value === 'ollama' ? 'native' : ''
  modelMenuOpen.value = false
  feedback.value = ''
}

async function fetchModels() {
  if (!draft.provider || modelLoading.value) return
  modelLoading.value = true
  modelError.value = ''
  modelMenuOpen.value = true
  try {
    const result = await byokApi.modelsPreview({
      provider: draft.provider,
      base_url: draft.base_url,
      api_format: draft.api_format,
      api_key: draft.value,
      credential_id: item.value?.id,
      model: draft.model,
    })
    modelOptions.value = result.models || []
    if (!modelOptions.value.length) modelError.value = t('profileByokUi.noModels')
  } catch (error) {
    modelOptions.value = []
    modelError.value = error instanceof Error ? error.message : t('profileByokUi.noModels')
  } finally {
    modelLoading.value = false
  }
}

function selectModel(model: string) {
  draft.model = model
  modelMenuOpen.value = false
}

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  feedback.value = ''
  feedbackType.value = ''
  try {
    const payload: Record<string, unknown> = {
      provider: draft.provider,
      capability: 'llm',
      api_format: draft.api_format,
      base_url: draft.base_url,
      model: draft.model,
    }
    if (draft.value) payload.value = draft.value

    if (item.value) {
      const row = await byokApi.update(item.value.id, { ...payload, enabled: true })
      item.value = row as Item
    } else {
      const row = await byokApi.create({ ...payload, value: draft.value }) as Item
      item.value = await byokApi.update(row.id, { enabled: true }) as Item
    }
    feedback.value = t('profileByokUi.saved')
    feedbackType.value = 'ok'
    window.dispatchEvent(new Event('gugu-quota-changed'))
    syncDraft(item.value)
    expanded.value = false
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : '保存失败'
    feedbackType.value = 'err'
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  if (!item.value || testing.value) return
  testing.value = true
  feedback.value = ''
  feedbackType.value = ''
  try {
    const result = await byokApi.test(item.value.id)
    feedback.value = result.message || (result.ok ? '检查通过' : '检查失败')
    feedbackType.value = result.ok ? 'ok' : 'err'
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : '检查失败'
    feedbackType.value = 'err'
  } finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.model-setup {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--space-xs);
}

.model-card-summary,
.model-card-editor {
  width: 100%;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
  color: var(--content-primary);
  box-shadow: var(--elevation-card);
}

.model-card-summary {
  min-height: 92px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  text-align: left;
  cursor: pointer;
  transition:
    transform var(--motion-hover-card) var(--motion-ease-emphasis),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-card) var(--motion-ease-standard);
}
.model-card-summary:hover {
  transform: translateY(-1px);
  border-color: var(--border-hover);
  background: var(--surface-soft-hover);
  box-shadow: var(--elevation-card-hover);
}
.model-card-summary:focus-visible {
  outline: 0;
  border-color: var(--border-focus);
  box-shadow: var(--control-focus-shadow), var(--elevation-card);
}
.model-card-summary.configured { border-color: var(--action-outline); }
.model-card-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: var(--control-radius);
  background: var(--action-soft);
  color: var(--action-primary);
}
.model-card-copy { min-width: 0; }
.model-card-copy b,.model-card-copy small { display: block; }
.model-card-copy b { font-size: var(--font-size-sm); }
.model-card-copy small { margin-top: var(--space-xs); color: var(--content-tertiary); font-size: var(--font-size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-card-state {
  min-width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0 var(--space-xs);
  border-radius: var(--control-radius);
  background: var(--control-bg);
  color: var(--control-fg);
  font-size: var(--font-size-xs);
}

.model-card-editor {
  padding: var(--space-md);
  animation: model-card-flip-in var(--motion-default) var(--motion-ease-emphasis);
  transform-origin: top center;
}
@keyframes model-card-flip-in {
  from { opacity: .35; transform: perspective(800px) rotateX(-7deg) translateY(-6px); }
  to { opacity: 1; transform: perspective(800px) rotateX(0) translateY(0); }
}
.model-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}
.model-editor-head b,.model-editor-head small { display: block; }
.model-editor-head b { font-size: var(--font-size-sm); }
.model-editor-head small { margin-top: var(--space-xs); color: var(--content-tertiary); font-size: var(--font-size-xs); }
.model-editor-close {
  width: 28px;
  height: 28px;
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-bg);
  color: var(--control-fg);
  cursor: pointer;
}
.model-editor-close:hover { border-color: var(--control-border-hover); background: var(--control-bg-hover); color: var(--control-fg-strong); }

.model-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-sm);
}
.model-field { min-width: 0; display: grid; gap: var(--space-xs); }
.model-field > span { color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.model-field :deep(.provider-select) { width: 100%; min-width: 0; }
.model-field :deep(.provider-trigger),.model-field .form-input { width: 100%; }
.model-field-wide { grid-column: 1 / -1; }
.model-picker-row { position: relative; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: var(--space-sm); }

.model-editor-actions {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-md);
}
.model-feedback { min-width: 0; flex: 1; color: var(--content-tertiary); font-size: var(--font-size-xs); }
.model-feedback.ok { color: var(--status-success); }
.model-feedback.err { color: var(--status-danger); }

:global(.onboarding-model-options) { min-width: 300px; max-height: 220px; overflow: auto; }
:global(.onboarding-model-options .model-option) {
  width: 100%;
  padding: var(--popup-item-padding);
  border: 0;
  border-radius: var(--popup-item-radius);
  background: transparent;
  color: var(--popup-item-fg);
  text-align: left;
  cursor: pointer;
}
:global(.onboarding-model-options .model-option:hover) { background: var(--popup-item-bg-hover); }
:global(.onboarding-model-options .model-option-hint) { padding: var(--space-sm); color: var(--content-tertiary); font-size: var(--font-size-xs); }
:global(.onboarding-model-options .model-option-hint.err) { color: var(--status-danger); }
</style>
