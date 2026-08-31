<template>
  <div class="local-capability-panel">
    <div class="capability-overrides">
      <Checkbox
        v-for="cap in LOCAL_CAPABILITIES"
        :key="cap.key"
        class="capability-override"
        :model-value="model.capability_overrides?.[cap.key] === true"
        :aria-label="t(cap.labelKey)"
        @update:model-value="onToggle(cap.key, $event)"
      >{{ t(cap.labelKey) }}</Checkbox>
    </div>

    <div v-if="hasResults" class="capability-results" aria-live="polite">
      <span class="capability-results-title">{{ t('localCapabilityUi.results') }}</span>
      <span
        v-for="cap in LOCAL_CAPABILITIES"
        :key="cap.key"
        class="capability-result"
        :class="resultClass(cap.key)"
      >
        {{ t(cap.labelKey) }}：{{ resultLabel(cap.key) }}
      </span>
    </div>
    <div v-if="checkedAt" class="modal-hint">{{ t('localCapabilityUi.lastChecked', { time: checkedAt }) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import Checkbox from '@/components/common/Checkbox.vue'
import { useI18n } from 'vue-i18n'

interface CapabilityResult {
  status?: string
  detail?: string
}

interface CapabilityModel {
  capability_overrides?: Record<string, boolean>
  [key: string]: unknown
}

const LOCAL_CAPABILITIES = [
  { key: 'tools', labelKey: 'localCapabilityUi.tools', resultKey: 'tools' },
  { key: 'structured_json', labelKey: 'localCapabilityUi.jsonOutput', resultKey: 'json_object' },
  { key: 'structured_schema', labelKey: 'localCapabilityUi.jsonSchema', resultKey: 'json_schema' },
  { key: 'thinking', labelKey: 'localCapabilityUi.reasoning', resultKey: 'reasoning' },
] as const
const { t } = useI18n()

const props = defineProps({
  model: { type: Object as PropType<CapabilityModel>, required: true },
  checkedAt: { type: String, default: '' },
  results: { type: Object as PropType<Record<string, CapabilityResult>>, default: () => ({}) },
})
const emit = defineEmits<{ toggle: [key: string, enabled: boolean] }>()

const hasResults = computed(() => Object.keys(props.results).length > 0)

function resultFor(key: string) {
  const cap = LOCAL_CAPABILITIES.find(item => item.key === key)
  return cap ? props.results[cap.resultKey] : undefined
}

function resultLabel(key: string) {
  const result = resultFor(key)
  if (!result) return t('localCapabilityUi.notTested')
  if (result.status === '支持') return t('localCapabilityUi.supported')
  if (result.status === '需服务端配置') return t('localCapabilityUi.notSupported')
  if (result.status === '未检测') return t('localCapabilityUi.notTested')
  return result.status || t('localCapabilityUi.unknown')
}

function resultClass(key: string) {
  const result = resultFor(key)
  if (result?.status === '支持') return 'is-supported'
  if (result?.status === '需服务端配置' || result?.status === '检测失败') return 'is-disabled'
  return 'is-unknown'
}

function onToggle(key: string, enabled: boolean) {
  emit('toggle', key, enabled)
}
</script>

<style scoped>
.local-capability-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  box-sizing: border-box;
  gap: 9px;
}

.capability-overrides {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.capability-override {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
  min-width: 0;
  color: var(--text-primary, rgba(255, 255, 255, 0.78));
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
}

.capability-results {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 18px;
}

.capability-results-title {
  color: var(--text-secondary, rgba(255, 255, 255, 0.5));
  margin-right: 2px;
}

.capability-result {
  padding: 1px 7px;
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 999px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
}

.capability-result.is-supported {
  color: var(--color-success, #75c7a1);
  border-color: color-mix(in srgb, var(--color-success, #75c7a1) 35%, transparent);
}

.capability-result.is-disabled {
  color: var(--color-danger, #e58c93);
  border-color: color-mix(in srgb, var(--color-danger, #e58c93) 35%, transparent);
}

.modal-hint {
  color: var(--text-secondary, rgba(255, 255, 255, 0.5));
  font-size: 11px;
  line-height: 1.5;
}
</style>
