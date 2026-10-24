<template>
  <div class="speech-fields">
    <div class="provider-selection-row">
      <ProviderSelect :model-value="draft.provider" :providers="providers" :popup-class="popupClass" @update:model-value="selectProvider" />
    </div>
    <InterfaceTypeSelect :label="t('profileByokUi.interfaceFormat')" :model-value="draft.api_format" :options="formats" @update:model-value="selectFormat(String($event))" />
    <input v-model="draft.base_url" class="form-input" :aria-label="t('llmExtraUi.baseUrl')" :placeholder="t('profileByokUi.baseUrlOptional')" />
    <input :value="apiKey" type="password" autocomplete="new-password" class="form-input" :aria-label="t('llmExtraUi.apiKey')" :placeholder="t(canKeepKey ? 'profileByokUi.apiKeyKeep' : 'profileByokUi.apiKey')" @input="$emit('update:apiKey', ($event.target as HTMLInputElement).value)" />
    <ModelPicker v-model="draft.model" :models="models" :open="menuOpen" :loading="loading" :disabled="!draft.provider" :show-fetch="draft.provider !== 'minimax'" :error="modelError" :placeholder="t('profileByokUi.speechModelOptional')" @fetch="fetchModels" @close="menuOpen = false" @select="draft.model = $event; menuOpen = false" />
    <p v-if="draft.api_format === 'minimax-asr'" class="speech-hint">{{ t('agentConfigUi.voiceModelHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import ProviderSelect from '@/views/Admin/Agent/components/ProviderSelect.vue'
import InterfaceTypeSelect from '@/views/Admin/Agent/components/InterfaceTypeSelect.vue'
import ModelPicker from './ModelPicker.vue'
import { SPEECH_PROVIDERS, speechFormats, speechProviderDefaults, type SpeechConnection } from '@/utils/speechModelConfig'

const props = defineProps({
  draft: { type: Object as PropType<SpeechConnection>, required: true },
  apiKey: { type: String, default: '' },
  keepKey: { type: Boolean, default: false },
  popupClass: { type: String, default: '' },
  loadModels: { type: Function as PropType<() => Promise<string[]>>, required: true },
})
const emit = defineEmits<{ 'update:apiKey': [value: string] }>()
const { t } = useI18n()
const initialDestination = `${props.draft.provider}|${props.draft.base_url}`
const canKeepKey = computed(() => props.keepKey && initialDestination === `${props.draft.provider}|${props.draft.base_url}`)
const providers = computed(() => SPEECH_PROVIDERS.map(item => ({ key: item.value, label: t(item.labelKey) })))
const formats = computed(() => speechFormats(props.draft.provider).map(key => ({ key, label: key === 'dashscope' ? 'DashScope' : t(key === 'minimax-asr' ? 'profileByokUi.minimaxAsr' : 'profileByokUi.chatCompletions') })))
const models = ref<string[]>([])
const loading = ref(false)
const modelError = ref('')
const menuOpen = ref(false)
let requestId = 0

function selectProvider(provider: string) {
  if (provider === props.draft.provider) return
  Object.assign(props.draft, speechProviderDefaults(provider))
  emit('update:apiKey', '')
}
function selectFormat(api_format: string) {
  if (api_format === props.draft.api_format) return
  props.draft.api_format = api_format
  if (props.draft.provider === 'qwen') {
    props.draft.base_url = api_format === 'dashscope' ? speechProviderDefaults('qwen').base_url : SPEECH_PROVIDERS.find(item => item.value === 'qwen')!.base_url
  }
}
function clearModels() {
  requestId++
  models.value = []
  modelError.value = ''
  menuOpen.value = false
  loading.value = false
}
watch(() => [props.draft.provider, props.draft.base_url, props.draft.api_format, props.apiKey], clearModels)
onBeforeUnmount(clearModels)
async function fetchModels() {
  if (menuOpen.value) { menuOpen.value = false; return }
  const id = ++requestId
  loading.value = true
  modelError.value = ''
  try {
    const result = await props.loadModels()
    if (id !== requestId) return
    models.value = result
    menuOpen.value = true
  } catch (cause) {
    if (id !== requestId) return
    modelError.value = cause instanceof Error ? cause.message : t('profileByokUi.noModels')
    menuOpen.value = true
  } finally {
    if (id === requestId) loading.value = false
  }
}
</script>

<style scoped>
.speech-fields { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.provider-selection-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.provider-selection-row :deep(.provider-select) { width: 100%; min-width: 0; }
.speech-fields .form-input { width: 100%; min-width: 0; box-sizing: border-box; }
.speech-hint { margin: 0; color: var(--text-secondary); font-size: 12px; }
</style>
