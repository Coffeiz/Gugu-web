<template>
  <div ref="root" class="model-picker">
    <div class="model-picker-row">
      <input :value="modelValue" class="form-input" :placeholder="placeholder" :aria-label="t('adminLlmUi.modelName')" @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)" @focus="$emit('open')" @keydown.esc.stop="$emit('close')" />
      <button v-if="showFetch" type="button" class="model-fetch-btn" :disabled="loading || disabled" @mousedown.prevent @click="$emit('fetch')">{{ t(loading ? 'profileByokUi.gettingModels' : 'profileByokUi.getModels') }}</button>
    </div>
    <Transition name="menu-pop">
      <div v-if="open" class="model-options" role="listbox" :aria-label="t('adminLlmUi.modelName')" @mousedown.stop>
        <div v-if="error" class="model-option-hint error" role="alert">{{ error }}</div>
        <div v-else-if="loading" class="model-option-hint" role="status">{{ t('profileByokUi.gettingModels') }}</div>
        <div v-else-if="!models.length" class="model-option-hint">{{ t('profileByokUi.noModels') }}</div>
        <div v-else-if="!filteredModels.length" class="model-option-hint">{{ t('profileByokUi.noModelsMatch', { kw: modelValue }) }}</div>
        <button v-for="model in error ? [] : filteredModels" :key="model" type="button" class="model-option" role="option" :aria-selected="modelValue === model" @mousedown.prevent @click="$emit('select', model)">{{ model }}</button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
const props = defineProps({
  modelValue: { type: String, default: '' },
  models: { type: Array as PropType<string[]>, default: () => [] },
  open: Boolean,
  loading: Boolean,
  disabled: Boolean,
  showFetch: { type: Boolean, default: true },
  error: { type: String, default: '' },
  placeholder: { type: String, default: '' },
})
const emit = defineEmits<{ 'update:modelValue': [value: string]; fetch: []; open: []; close: []; select: [value: string] }>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const filteredModels = computed(() => props.models.filter(model => model.toLowerCase().includes(props.modelValue.trim().toLowerCase())))
function closeOutside(event: MouseEvent) {
  if (props.open && !root.value?.contains(event.target as Node)) emit('close')
}
onMounted(() => document.addEventListener('mousedown', closeOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', closeOutside))
</script>

<style scoped>
.model-picker { position: relative; min-width: 0; }
.model-picker-row { display: flex; gap: 6px; min-width: 0; }
.form-input { flex: 1; width: 100%; min-width: 0; box-sizing: border-box; }
.model-fetch-btn { flex: 0 0 auto; padding: 6px 10px; border: 1px solid var(--control-border); border-radius: 8px; background: var(--control-bg); color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.model-fetch-btn:disabled { opacity: .5; cursor: default; }
.model-options { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-height: 180px; overflow-y: auto; padding: var(--popup-surface-padding); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow); }
.model-option { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
.model-option:hover { background: var(--control-bg-hover); }
.model-option-hint { padding: 7px 9px; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
.model-option-hint.error { color: var(--status-danger); }
</style>
