<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileByokUi.title') }}</div>
      <p class="pm-field-hint">{{ t('profileByokUi.hint') }}</p>
      <div v-if="needsReconfigure" class="pm-msg err">{{ t('profileByokUi.reconfigure') }}</div>
      <div v-if="loading" class="pm-field-hint">{{ t('profileByokUi.loading') }}</div>
      <div v-else-if="error" class="pm-msg err">{{ error }}</div>
      <template v-else>
        <div v-for="group in groups" :key="group.value" class="byok-group">
          <div class="byok-group-heading"><div class="byok-group-title">{{ t(group.labelKey) }}</div><button class="pm-style-chip" @click="openEditor(group.value)">{{ t('profileByokUi.addModel') }}</button></div>
          <div v-if="itemsFor(group.value).length === 0" class="pm-field-hint">{{ t('profileByokUi.notConfigured') }}</div>
          <div v-if="itemsFor(group.value).length" class="byok-card-grid">
            <template v-for="item in itemsFor(group.value)" :key="item.id">
            <div class="byok-card">
              <div class="byok-card-head">
                <div class="byok-card-main">
                  <div class="byok-name">{{ providerLabel(item.provider) }}<span v-if="item.model"> · {{ item.model }}</span><template v-if="item.capability === 'llm'"><span v-for="dim in visionDims.filter(entry => item[entry.field])" :key="dim.key" class="byok-capability-tag">{{ t(dim.labelKey) }}</span></template></div>
                  <div class="byok-meta">{{ item.api_format || t('profileByokUi.autoProtocol') }} · {{ item.has_value ? t('profileByokUi.encrypted') : t('profileByokUi.noCredential') }}</div>
                </div>
              </div>
              <div class="byok-card-actions">
                <button class="pm-style-chip" @click="openEditor(item.capability, item)">{{ t('profileByokUi.edit') }}</button>
                <button class="pm-style-chip" :disabled="testing === item.id" @click="test(item)">{{ testing === item.id ? t('profileByokUi.testing') : t('profileByokUi.test') }}</button>
                <button v-if="item.capability === 'llm'" class="pm-style-chip" :disabled="visionTesting?.startsWith(`${item.id}:`)" @click="probeCardVisionAll(item)">{{ visionTesting === `${item.id}:all` ? t('profileByokUi.probing') : t('profileByokUi.probe') }}</button>
                <button class="pm-style-chip" :class="{ active: item.enabled }" @click="toggle(item)">{{ item.enabled ? t('profileByokUi.enabled') : t('profileByokUi.disabled') }}</button>
                <button class="pm-danger-btn" @click="remove(item)">{{ t('profileByokUi.delete') }}</button>
              </div>
            </div>
            <Transition :name="editors[item.id] || closingEditors.has(item.id) ? 'byok-editor' : 'byok-editor-none'" @after-leave="clearClosingEditor(item.id)">
            <div v-if="editors[item.id]" :key="item.id" class="byok-editor byok-editor--expanded" @click="setActiveEditor(item.id)">
            <div class="byok-editor-title">{{ t('profileByokUi.editTitle') }}</div>
            <div class="byok-form-grid">
              <div class="provider-selection-row" :class="{ 'provider-selection-row--single': !childProviderOptionsFor(editors[item.id]).length }">
                <ProviderSelect :model-value="editors[item.id].provider" :providers="providerOptionsFor(editors[item.id].capability)" @update:model-value="applyProvider(editors[item.id], $event)" />
                <ProviderSelect v-if="childProviderOptionsFor(editors[item.id]).length" :model-value="childSelectionFor(editors[item.id])" :providers="childProviderOptionsFor(editors[item.id])" :placeholder="t('profileByokUi.selectChild')" @update:model-value="applyProviderChild(editors[item.id], $event)" />
              </div>
              <InterfaceTypeSelect v-if="editors[item.id].provider === 'mimo'" :label="t('profileByokUi.interfaceFormat')" :model-value="editors[item.id].api_format || 'openai'" :options="[{ key: 'openai', label: t('profileByokUi.openaiCompatible') }, { key: 'anthropic', label: t('profileByokUi.anthropicCompatible') }]" :hint="t('profileByokUi.anthropicHint')" @update:model-value="editors[item.id].api_format = String($event)" />
              <InterfaceTypeSelect v-else-if="editors[item.id].provider === 'ollama'" :label="t('profileByokUi.interfaceType')" :model-value="editors[item.id].api_format || 'native'" :options="ollamaInterfaceOptions" @update:model-value="editors[item.id].api_format = String($event)" />
              <input v-model="editors[item.id].base_url" class="form-input" :placeholder="t('profileByokUi.baseUrlOptional')" />
              <input v-model="editors[item.id].value" class="form-input" type="password" autocomplete="new-password" :placeholder="t('profileByokUi.apiKeyKeep')" />
              <div class="model-picker" :ref="el => setModelPickerRef(item.id, el)"><div class="model-picker-row"><input v-model="editors[item.id].model" class="form-input" :placeholder="group.value === 'speech_to_text' ? t('profileByokUi.speechModelOptional') : t('profileByokUi.modelOptional')" /><button type="button" class="pm-style-chip" :disabled="modelLoading" @click="fetchModels($event)">{{ modelLoading ? t('profileByokUi.gettingModels') : t('profileByokUi.getModels') }}</button></div><PopupMenu :show="modelMenuOpen && editor?.id === item.id" :anchor="modelAnchor" popup-class="model-options"><div v-if="modelError" class="model-option-hint err">{{ modelError }}</div><div v-else-if="!modelOptions.length" class="model-option-hint">{{ t('profileByokUi.noModels') }}</div><button v-for="model in modelOptions" :key="model" type="button" class="model-option" @click="selectModel(model)">{{ model }}</button></PopupMenu></div>
              <template v-if="editors[item.id].capability === 'llm'"><div class="byok-subsection"><div class="byok-subsection-title">{{ t('profileByokUi.thinkingIntensity') }}</div><AdminSelect v-model="editors[item.id].thinking_mode" :options="thinkingOptionsFor(editors[item.id])" :placeholder="t('profileByokUi.thinkingPlaceholder')" @update:model-value="applyThinkingOption(editors[item.id], $event)" /></div><div class="byok-subsection"><div class="byok-subsection-title">{{ t('profileByokUi.contextBudget') }}</div><div class="byok-budget-grid"><input v-model.number="editors[item.id].context_tokens" class="form-input" type="number" step="500" :placeholder="t('profileByokUi.inputTokens')" /><input v-model.number="editors[item.id].max_tokens" class="form-input" type="number" step="100" :placeholder="t('profileByokUi.outputTokens')" /></div></div></template>
              <MultimodalCapabilities v-if="editors[item.id].capability === 'llm'" :model="editors[item.id]" :dims="localizedVisionDims" :probe-label="t('profileByokUi.detect')" :probing-label="t('profileByokUi.detecting')" :title="t('profileByokUi.multimodal')" :probing="visionTesting" @probe="probeVision" />
            </div>
            <div class="byok-editor-actions"><button class="pm-style-chip" :disabled="testing === item.id" @click="test({ id: item.id, capability: editors[item.id].capability })">{{ testing === item.id ? t('profileByokUi.testing') : t('profileByokUi.test') }}</button><button class="pm-style-chip" @click="closeEditor(item.id)">{{ t('profileByokUi.cancel') }}</button><button class="pm-style-chip active" :disabled="saving || !editors[item.id].provider" @click="saveEditor(item.id)">{{ saving ? t('profileByokUi.saving') : t('profileByokUi.saveConfig') }}</button></div>
            </div>
            </Transition>
            </template>
          </div>
          <div v-if="newEditor && newEditor.capability === group.value" class="byok-editor byok-editor--new">
            <div class="byok-editor-title">{{ t('profileByokUi.addConfig', { label: t(group.labelKey) }) }}</div>
            <div class="byok-form-grid">
              <div class="provider-selection-row" :class="{ 'provider-selection-row--single': !childProviderOptionsFor(newEditor).length }">
                <ProviderSelect :model-value="newEditor.provider" :providers="providerOptionsFor(newEditor.capability)" @update:model-value="applyProviderTo(newEditor, $event)" />
                <ProviderSelect v-if="childProviderOptionsFor(newEditor).length" :model-value="childSelectionFor(newEditor)" :providers="childProviderOptionsFor(newEditor)" :placeholder="t('profileByokUi.selectChild')" @update:model-value="applyProviderChild(newEditor, $event)" />
              </div>
              <InterfaceTypeSelect v-if="newEditor.provider === 'mimo'" :label="t('profileByokUi.interfaceFormat')" :model-value="newEditor.api_format || 'openai'" :options="[{ key: 'openai', label: t('profileByokUi.openaiCompatible') }, { key: 'anthropic', label: t('profileByokUi.anthropicCompatible') }]" :hint="t('profileByokUi.anthropicHint')" @update:model-value="newEditor.api_format = String($event)" />
              <InterfaceTypeSelect v-else-if="newEditor.provider === 'ollama'" :label="t('profileByokUi.interfaceType')" :model-value="newEditor.api_format || 'native'" :options="ollamaInterfaceOptions" @update:model-value="newEditor.api_format = String($event)" />
              <input v-model="newEditor.base_url" class="form-input" :placeholder="t('profileByokUi.baseUrlOptional')" />
              <input v-model="newEditor.value" class="form-input" type="password" autocomplete="new-password" :placeholder="t('profileByokUi.apiKey')" />
              <div class="model-picker"><div class="model-picker-row"><input v-model="newEditor.model" class="form-input" :placeholder="t('profileByokUi.modelOptional')" /><button type="button" class="pm-style-chip" :disabled="modelLoading" @click="fetchModels($event)">{{ modelLoading ? t('profileByokUi.gettingModels') : t('profileByokUi.getModels') }}</button></div><PopupMenu :show="modelMenuOpen && newEditor !== null" :anchor="modelAnchor" popup-class="model-options"><div v-if="modelError" class="model-option-hint err">{{ modelError }}</div><div v-else-if="!modelOptions.length" class="model-option-hint">{{ t('profileByokUi.noModels') }}</div><button v-for="model in modelOptions" :key="model" type="button" class="model-option" @click="selectModel(model)">{{ model }}</button></PopupMenu></div>
              <template v-if="newEditor.capability === 'llm'"><div class="byok-subsection"><div class="byok-subsection-title">{{ t('profileByokUi.thinkingIntensity') }}</div><AdminSelect v-model="newEditor.thinking_mode" :options="thinkingOptionsFor(newEditor)" :placeholder="t('profileByokUi.thinkingPlaceholder')" @update:model-value="applyThinkingOption(newEditor, $event)" /></div><div class="byok-subsection"><div class="byok-subsection-title">{{ t('profileByokUi.contextBudget') }}</div><div class="byok-budget-grid"><input v-model.number="newEditor.context_tokens" class="form-input" type="number" step="500" :placeholder="t('profileByokUi.inputTokens')" /><input v-model.number="newEditor.max_tokens" class="form-input" type="number" step="100" :placeholder="t('profileByokUi.outputTokens')" /></div></div></template>
              <MultimodalCapabilities v-if="newEditor.capability === 'llm'" :model="newEditor" :dims="localizedVisionDims" :probe-label="t('profileByokUi.detect')" :probing-label="t('profileByokUi.detecting')" :title="t('profileByokUi.multimodal')" :probing="visionTesting" @probe="probeNewVision" />
            </div>
            <div class="byok-editor-actions"><button class="pm-style-chip" @click="closeNewEditor">{{ t('profileByokUi.cancel') }}</button><button class="pm-style-chip active" :disabled="saving || !newEditor.provider || !newEditor.value" @click="saveNewEditor">{{ saving ? t('profileByokUi.saving') : t('profileByokUi.saveConfig') }}</button></div>
          </div>
          <div v-if="message && messageCapability === group.value" class="byok-message pm-msg" :class="messageType">{{ message }}</div>
        </div>
      </template>
    </div>
    <div class="pm-sep"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { byokApi } from '@/services/api'
import AdminSelect from '@/components/AdminSelect.vue'
import ProviderSelect from '@/views/Admin/Agent/components/ProviderSelect.vue'
import InterfaceTypeSelect from '@/views/Admin/Agent/components/InterfaceTypeSelect.vue'
import MultimodalCapabilities from '@/components/common/MultimodalCapabilities.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { useI18n } from 'vue-i18n'
import { MODEL_PROVIDERS, type ModelProvider } from '@/utils/modelProviders'

type Item = { id: number; capability: string; provider: string; api_format: string; base_url: string; model: string; max_tokens: number | null; context_tokens: number | null; thinking: 'disabled' | 'adaptive' | null; reasoning_effort: string | null; vision: boolean; vision_video: boolean; vision_audio: boolean; vision_detail: string; has_value: boolean; enabled: boolean; [key: string]: any }
type ThinkingMode = 'default' | 'disabled' | 'adaptive' | 'low' | 'medium' | 'high' | 'max'
type Editor = { id?: number; capability: string; provider: string; value: string; api_format: string; base_url: string; model: string; max_tokens: number | null; context_tokens: number | null; thinking: 'disabled' | 'adaptive' | null; reasoning_effort: string | null; thinking_mode: ThinkingMode; vision: boolean; vision_video: boolean; vision_audio: boolean; vision_detail: string; local_runtime?: string; ollama_mode?: string }
type ThinkingOption = { value: ThinkingMode; label: string }
type ProviderOption = ModelProvider
const modelProviders: readonly ProviderOption[] = MODEL_PROVIDERS
const groups = [
  { value: 'llm', labelKey: 'profileByokUi.generalModel' }, { value: 'speech_to_text', labelKey: 'profileByokUi.speechModel' },
]
const visionDims = [{ key: 'image', labelKey: 'profileByokUi.image', field: 'vision' }, { key: 'video', labelKey: 'profileByokUi.video', field: 'vision_video' }, { key: 'audio', labelKey: 'profileByokUi.audio', field: 'vision_audio' }] as const
const providerChildren: Record<string, Array<{ key: string; labelKey: string }>> = {
  glm: [{ key: 'general', labelKey: 'profileByokUi.generalApi' }, { key: 'coding', labelKey: 'profileByokUi.codingPlan' }],
  local: [{ key: 'llama.cpp', labelKey: 'profileByokUi.llamaCpp' }, { key: 'vllm', labelKey: 'profileByokUi.vllm' }, { key: 'other', labelKey: 'profileByokUi.otherCompatible' }],
  ollama: [{ key: 'local', labelKey: 'profileByokUi.localOllama' }, { key: 'cloud', labelKey: 'profileByokUi.ollamaCloud' }],
}
const thinkingLabels: Record<ThinkingMode, string> = {
  default: 'profileByokUi.inheritDefault', disabled: 'profileByokUi.disableThinking', adaptive: 'profileByokUi.adaptiveThinking',
  low: 'profileByokUi.low', medium: 'profileByokUi.medium', high: 'profileByokUi.high', max: 'profileByokUi.maximum',
}
const providerEfforts: Record<string, ThinkingMode[]> = {
  deepseek: ['low', 'high', 'max'],
  ollama: ['low', 'medium', 'high', 'max'],
}
const ollamaInterfaceOptions = computed(() => [
  { key: 'native', label: t('profileByokUi.ollamaNative') },
  { key: 'openai', label: t('profileByokUi.openaiCompatible') },
])
const { t } = useI18n()
const localizedVisionDims = computed(() => visionDims.map(dim => ({ ...dim, label: t(dim.labelKey) })))
const items = ref<Item[]>([]); const loading = ref(false); const saving = ref(false); const testing = ref<number | null>(null); const visionTesting = ref<string | null>(null); const needsReconfigure = ref(false); const error = ref(''); const message = ref(''); const messageCapability = ref(''); const messageType = ref('ok'); const editor = ref<Editor | null>(null); const editors = ref<Record<number, Editor>>({}); const closingEditors = ref(new Set<number>()); const newEditor = ref<Editor | null>(null); const lastEditorWasExisting = ref(false); const modelLoading = ref(false); const modelError = ref(''); const modelOptions = ref<string[]>([]); const modelMenuOpen = ref(false); const modelPickerRefs = ref<Record<number, HTMLElement | null>>({}); const modelAnchor = ref<HTMLElement | null>(null)
function setModelPickerRef(id: number, element: Element | null | unknown) { modelPickerRefs.value[id] = element instanceof HTMLElement ? element : null }
function itemsFor(capability: string) { return items.value.filter(item => item.capability === capability) }
function providersFor(capability: string): readonly ProviderOption[] {
  return capability === 'speech_to_text' ? modelProviders.filter(item => ['openai', 'qwen', 'local'].includes(item.value)) : modelProviders
}
function thinkingEffortsFor(draft: Pick<Editor, 'provider' | 'model'>): ThinkingMode[] {
  if (draft.provider === 'qwen' && !/^qwen3/i.test(draft.model || '')) return []
  return providerEfforts[draft.provider] || []
}
function thinkingOptionsFor(draft: Pick<Editor, 'provider' | 'model'>): ThinkingOption[] {
  const supportsThinking = ['deepseek', 'qwen', 'mimo', 'glm', 'glm-coding', 'ollama'].includes(draft.provider)
  return [
    { value: 'default', label: t(thinkingLabels.default) },
    { value: 'disabled', label: t(thinkingLabels.disabled) },
    ...(supportsThinking ? [{ value: 'adaptive' as ThinkingMode, label: t(thinkingLabels.adaptive) }] : []),
    ...thinkingEffortsFor(draft).map(value => ({ value, label: t(thinkingLabels[value]) })),
  ]
}
function thinkingModeFor(thinking: Editor['thinking'], effort: string | null): ThinkingMode {
  if (thinking === 'disabled') return 'disabled'
  if (thinking === 'adaptive' && ['low', 'medium', 'high', 'max'].includes(effort || '')) return effort as ThinkingMode
  if (thinking === 'adaptive') return 'adaptive'
  return 'default'
}
function applyThinkingOption(draft: Editor, value: ThinkingMode) {
  draft.thinking_mode = value
  if (value === 'default') { draft.thinking = null; draft.reasoning_effort = null; return }
  if (value === 'disabled') { draft.thinking = 'disabled'; draft.reasoning_effort = ''; return }
  draft.thinking = 'adaptive'
  draft.reasoning_effort = value === 'adaptive' ? '' : value
}
function providerOptionsFor(capability: string) {
  return providersFor(capability).map(provider => ({ key: provider.value, label: t(provider.labelKey) }))
}
function providerLabel(value: string) {
  const provider = modelProviders.find(item => item.value === value)
  return provider ? t(provider.labelKey) : value
}
function childProviderOptionsFor(draft: Pick<Editor, 'provider' | 'base_url' | 'local_runtime' | 'ollama_mode'>) {
  return (providerChildren[draft.provider] || []).map(child => ({ key: child.key, label: t(child.labelKey) }))
}
function childSelectionFor(draft: Pick<Editor, 'provider' | 'base_url' | 'local_runtime' | 'ollama_mode'>) {
  if (draft.provider === 'glm') return (draft.base_url || '').includes('/api/coding/') ? 'coding' : 'general'
  if (draft.provider === 'local') return draft.local_runtime || 'other'
  if (draft.provider === 'ollama') return draft.ollama_mode || ((draft.base_url || '').includes('ollama.com') ? 'cloud' : 'local')
  return ''
}
function applyProvider(draft: Editor, value: string) {
  draft.provider = value
  const provider = modelProviders.find(item => item.value === value)
  if (!provider) return
  draft.base_url = provider.base_url
  draft.model = provider.model
  draft.api_format = value === 'mimo' ? 'openai' : value === 'ollama' ? 'native' : ''
  if (!thinkingOptionsFor(draft).some(option => option.value === draft.thinking_mode)) applyThinkingOption(draft, 'default')
}
function applyProviderChild(draft: Editor, value: string) {
  if (draft.provider === 'glm') {
    draft.base_url = value === 'coding' ? 'https://open.bigmodel.cn/api/coding/paas/v4' : 'https://open.bigmodel.cn/api/paas/v4'
  } else if (draft.provider === 'local') {
    draft.local_runtime = value
  } else if (draft.provider === 'ollama') {
    draft.ollama_mode = value
    draft.base_url = value === 'cloud' ? 'https://ollama.com/v1' : 'http://127.0.0.1:11434/v1'
    if (value === 'local') draft.value = ''
  }
}
async function fetchModels(event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) modelAnchor.value = event.currentTarget.closest('.model-picker') as HTMLElement | null
  const draft = editor.value || newEditor.value
  if (!draft || !draft.provider) return
  if (modelMenuOpen.value && !modelLoading.value) { modelMenuOpen.value = false; return }
  modelLoading.value = true; modelError.value = ''; modelMenuOpen.value = true
  try {
    const result = await byokApi.modelsPreview({ provider: draft.provider, base_url: draft.base_url, api_format: draft.api_format, api_key: draft.value, credential_id: draft.id })
    modelOptions.value = result.models || []
    if (!modelOptions.value.length) modelError.value = 'Provider 没有返回可用模型'
  } catch (e) { modelOptions.value = []; modelError.value = e instanceof Error ? e.message : '获取模型列表失败' }
  finally { modelLoading.value = false }
}
function selectModel(model: string) { const draft = editor.value || newEditor.value; if (draft) draft.model = model; modelMenuOpen.value = false }
async function probeVision(dim: typeof visionDims[number]['key']) { if (!editor.value || !editor.value.provider || !editor.value.model) return; visionTesting.value = dim; try { const result = await byokApi.visionProbe({ provider: editor.value.provider, api_format: editor.value.api_format, base_url: editor.value.base_url, api_key: editor.value.value, credential_id: editor.value.id, model: editor.value.model, dim }); if (result.supported !== null) { const field = visionDims.find(item => item.key === dim)?.field; if (field && editor.value) { editor.value[field] = result.supported; const saved = items.value.find(item => item.id === editor.value?.id); if (saved) saved[field] = result.supported } } message.value = result.detail || (result.supported === true ? `${dim}能力支持` : result.supported === false ? `${dim}能力不支持` : `${dim}能力未能判定`); messageType.value = result.supported === true ? 'ok' : 'err' } catch (e) { message.value = e instanceof Error ? e.message : '多模态检测失败'; messageType.value = 'err' } finally { visionTesting.value = null } }
async function probeCardVisionAll(item: Item) {
  if (!item.provider || !item.model) return
  visionTesting.value = `${item.id}:all`
  messageCapability.value = item.capability
  const labels = { image: '图片', video: '视频', audio: '音频' } as const
  const results: string[] = []
  const detected: Record<string, boolean> = {}
  try {
    for (const dim of visionDims) {
      const result = await byokApi.visionProbe({ provider: item.provider, api_format: item.api_format, base_url: item.base_url, api_key: '', credential_id: item.id, model: item.model, dim: dim.key })
      const field = dim.field
      if (result.supported !== null) { item[field] = result.supported; detected[field] = result.supported }
      results.push(`${labels[dim.key]}：${result.supported === true ? '支持' : result.supported === false ? '不支持' : '测不准'}`)
    }
    if (Object.keys(detected).length) Object.assign(item, await byokApi.update(item.id, detected))
    message.value = `多模态检测完成（${results.join('；')}）`
    messageType.value = results.some(result => result.endsWith('测不准')) ? 'err' : 'ok'
  } catch (e) { message.value = e instanceof Error ? e.message : '多模态检测失败'; messageType.value = 'err' }
  finally { visionTesting.value = null }
}
async function load() { loading.value = true; error.value = ''; try { const result = await byokApi.list(); items.value = result.items as Item[]; needsReconfigure.value = result.status === 'needs_reconfigure' } catch (e) { error.value = e instanceof Error ? e.message : 'BYOK 加载失败' } finally { loading.value = false } }
function setActiveEditor(id: number) { editor.value = editors.value[id] || null }
function openEditor(capability: string, item?: Item) { if (item) { if (editors.value[item.id]) { closeEditor(item.id); return } lastEditorWasExisting.value = true; const draft = { id: item.id, capability, provider: item.provider, value: '', api_format: item.api_format || '', base_url: item.base_url || '', model: item.model || '', max_tokens: item.max_tokens ?? null, context_tokens: item.context_tokens, thinking: item.thinking, reasoning_effort: item.reasoning_effort, thinking_mode: thinkingModeFor(item.thinking, item.reasoning_effort), vision: Boolean(item.vision), vision_video: Boolean(item.vision_video), vision_audio: Boolean(item.vision_audio), vision_detail: item.vision_detail || 'auto', local_runtime: item.local_runtime, ollama_mode: item.ollama_mode }; editors.value[item.id] = draft; editor.value = draft; newEditor.value = null } else { editor.value = null; newEditor.value = { capability, provider: '', value: '', api_format: '', base_url: '', model: '', max_tokens: null, context_tokens: null, thinking: null, reasoning_effort: null, thinking_mode: 'default', vision: false, vision_video: false, vision_audio: false, vision_detail: 'auto' } } modelOptions.value = []; modelError.value = ''; modelMenuOpen.value = false; message.value = '' }
function applyProviderTo(target: Editor, value: string) { applyProvider(target, value) }
function closeNewEditor() { newEditor.value = null }
function notifyQuotaChanged() { window.dispatchEvent(new Event('gugu-quota-changed')) }
async function saveNewEditor() { if (!newEditor.value) return; saving.value = true; try { const draft = newEditor.value; const row = await byokApi.create({ provider: draft.provider, capability: draft.capability, value: draft.value, api_format: draft.api_format, base_url: draft.base_url, model: draft.model, max_tokens: draft.max_tokens, context_tokens: draft.context_tokens, thinking: draft.thinking, reasoning_effort: draft.reasoning_effort, vision: draft.vision, vision_video: draft.vision_video, vision_audio: draft.vision_audio, vision_detail: draft.vision_detail }); items.value.push(row as Item); newEditor.value = null; notifyQuotaChanged() } catch (e) { message.value = e instanceof Error ? e.message : '保存失败'; messageType.value = 'err' } finally { saving.value = false } }
function probeNewVision(dim: string) { if (!newEditor.value) return; const previous = editor.value; editor.value = newEditor.value; void probeVision(dim as typeof visionDims[number]['key']).finally(() => { if (newEditor.value) newEditor.value = editor.value; editor.value = previous }) }
function clearClosingEditor(id: number) { closingEditors.value.delete(id) }
function closeEditor(id?: number) { if (id !== undefined) { closingEditors.value.add(id); delete editors.value[id] }; editor.value = id !== undefined && editor.value?.id === id ? null : editor.value; modelMenuOpen.value = false }
async function saveEditor(id: number) { const draft = editors.value[id]; if (!draft) return; saving.value = true; message.value = ''; try { const payload: Record<string, unknown> = { provider: draft.provider, capability: draft.capability, api_format: draft.api_format, base_url: draft.base_url, model: draft.model, max_tokens: draft.max_tokens, context_tokens: draft.context_tokens, thinking: draft.thinking, reasoning_effort: draft.reasoning_effort, vision: draft.vision, vision_video: draft.vision_video, vision_audio: draft.vision_audio, vision_detail: draft.vision_detail }; if (draft.value) payload.value = draft.value; const row = await byokApi.update(id, payload); const index = items.value.findIndex(item => item.id === row.id); if (index >= 0) items.value[index] = row as Item; delete editors.value[id]; if (editor.value?.id === id) editor.value = null; message.value = '模型配置已保存'; messageType.value = 'ok'; notifyQuotaChanged() } catch (e) { message.value = e instanceof Error ? e.message : '保存失败'; messageType.value = 'err' } finally { saving.value = false } }
async function toggle(item: Item) { try { const enabled = !item.enabled; Object.assign(item, await byokApi.update(item.id, { enabled })); if (enabled) items.value.filter(row => row.capability === item.capability && row.id !== item.id).forEach(row => { row.enabled = false }); notifyQuotaChanged() } catch (e) { message.value = e instanceof Error ? e.message : '更新失败'; messageType.value = 'err' } }
async function test(item: { id: number; capability: string }) { testing.value = item.id; messageCapability.value = item.capability; try { const body = await byokApi.test(item.id); message.value = body.message || (body.ok ? '检查通过' : '检查失败'); messageType.value = body.ok ? 'ok' : 'err' } catch (e) { message.value = e instanceof Error ? e.message : '检查失败'; messageType.value = 'err' } finally { testing.value = null } }
async function remove(item: Item) {
  if (!await confirmDialog({
    title: t('profileByokUi.deleteTitle'),
    message: t('profileByokUi.deleteMessage', { provider: providerLabel(item.provider) }),
    tone: 'danger',
    confirmText: t('profileByokUi.deleteConfirm'),
  })) return
  try {
    await byokApi.remove(item.id)
    items.value = items.value.filter(row => row.id !== item.id)
    if (items.value.length === 0) needsReconfigure.value = false
    notifyQuotaChanged()
  } catch (e) {
    message.value = e instanceof Error ? e.message : t('profileByokUi.deleteFailed')
    messageType.value = 'err'
  }
}
function closeModelMenuOnOutside(event: MouseEvent) {
  const target = event.target
  if (modelMenuOpen.value && (!(target instanceof Element) || !target.closest('.model-picker'))) modelMenuOpen.value = false
}
onMounted(() => { load(); document.addEventListener('mousedown', closeModelMenuOnOutside) })
onBeforeUnmount(() => document.removeEventListener('mousedown', closeModelMenuOnOutside))
</script>

<style scoped>
.byok-group { margin-top: 14px; }
.byok-group-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.byok-group-title { color: var(--text-primary); font-size: 13px; font-weight: 650; margin-bottom: 6px; }
.byok-card-grid { display: grid; grid-template-columns: 1fr; row-gap: 10px; margin-top: 8px; }
.byok-card { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 11px 12px; border: 1px solid var(--input-border, var(--divider-line)); border-radius: 12px; background: var(--surface-subtle); box-shadow: inset 0 1px rgba(255,255,255,.18); }
.byok-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.byok-card-head { flex: 1; min-width: 0; }
.byok-card-main { min-width: 0; }
.byok-name { min-width: 0; color: var(--text-primary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.byok-capability-tag { display: inline-flex; margin-left: 5px; padding: 2px 6px; border: 1px solid color-mix(in srgb, var(--accent-color, #7b7fb2) 35%, transparent); border-radius: var(--choice-chip-radius); color: var(--text-secondary); font-size: 10px; vertical-align: 1px; }
.byok-meta { color: var(--text-secondary); font-size: 11px; margin-top: 3px; }
.byok-expired { color: var(--color-danger, #c66); }
.byok-card-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex-shrink: 0; }
.byok-card-actions .pm-danger-btn { padding: 5px 10px; border-radius: var(--choice-chip-radius); }
.byok-message { margin-top: 12px; }
.byok-form-grid { display: grid; grid-template-columns: 1fr; gap: 8px; margin: 10px 0; }
.byok-editor { margin-top: 8px; padding: 12px; border: 1px solid var(--input-border); border-radius: 10px; background: var(--surface-subtle); }
.byok-editor--expanded { margin-top: 0; border-top: 1px solid var(--input-border); border-left: 0; border-right: 0; border-top-left-radius: 0; border-top-right-radius: 0; box-shadow: inset 1px 0 var(--input-border), inset -1px 0 var(--input-border); }
.byok-card-grid, .byok-editor { overflow-anchor: none; }
.byok-card-grid:has(.byok-editor--expanded) { row-gap: 10px; }
.byok-card:has(+ .byok-editor--expanded) { margin-bottom: -10px; border-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.byok-editor--expanded { grid-column: 1; }
.byok-editor-enter-active { max-height: 420px; box-sizing: border-box; overflow: hidden; transition: max-height .32s cubic-bezier(.22,.61,.36,1), padding .24s ease-out; }
.byok-editor-leave-active { max-height: 420px; box-sizing: border-box; overflow: hidden; transition: max-height .34s cubic-bezier(.16, 1, .3, 1), padding .26s cubic-bezier(.16, 1, .3, 1); }
.byok-editor-enter-from, .byok-editor-leave-to { max-height: 0; padding-top: 0; padding-bottom: 0; }
.byok-editor-enter-to, .byok-editor-leave-from { max-height: 420px; }
.byok-editor .form-input { height: 34px; box-sizing: border-box; }
.provider-selection-row { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:6px; grid-column:1 / -1; }
.provider-selection-row--single { grid-template-columns:1fr; }
.provider-selection-row .provider-select { min-width:0; width:100%; }
:deep(.interface-type-select) { grid-column:1 / -1; }
.byok-editor-title { color: var(--text-primary); font-size: 12px; font-weight: 650; }
.byok-subsection { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding-top: 0; border-top: 1px solid var(--divider-line); }
.byok-subsection-title { color: var(--text-primary); font-size: 12px; font-weight: 650; }
.byok-subsection .asel-wrap { min-width: 0; }
.byok-subsection .asel-trigger { width: 100%; box-sizing: border-box; }
.byok-budget-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.byok-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
.model-picker { position: relative; min-width: 0; }
.model-picker-row { display: flex; gap: 6px; }
.model-picker-row .form-input { min-width: 0; flex: 1; }
.model-options { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-height: 180px; overflow-y: auto; padding: var(--popup-surface-padding); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight); backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur); }
.model-option { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: var(--popup-item-radius); background: none; color: var(--popup-item-fg); text-align: left; cursor: pointer; }
.model-option:hover { background: var(--popup-item-bg-hover); }
.model-option-hint { padding: 7px 9px; color: var(--popup-item-fg-muted); font-size: 12px; }
.api-format-field { grid-column: 1 / -1; }
:deep(.byok-editor .multimodal-capabilities) { grid-column: 1 / -1; width: 100%; }
.byok-editor .multimodal-capability-row { max-width: 360px; }
.field-label { display: block; margin-bottom: 5px; color: var(--text-secondary); font-size: 11px; }
.api-format-grid { display: flex; gap: 6px; }
@media (max-width: 680px) { .byok-card-grid { grid-template-columns: 1fr; } .byok-card { align-items: flex-start; flex-wrap: wrap; } .byok-card-actions { width: 100%; } .byok-budget-grid { grid-template-columns: 1fr; } }
</style>
