<template>
  <div class="local-capability-panel">
    <div class="capability-overrides">
      <label v-for="cap in LOCAL_CAPABILITIES" :key="cap.key" class="capability-override">
        <input
          type="checkbox"
          :checked="model.capability_overrides?.[cap.key] === true"
          @change="onToggle(cap.key, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ cap.label }}</span>
      </label>
    </div>

    <button type="button" class="capability-probe" :disabled="disabled || loading" @click="$emit('probe')">
      {{ loading ? '检测中…' : '检测本地能力' }}
    </button>

    <div v-if="hasResults" class="capability-results" aria-live="polite">
      <span class="capability-results-title">检测结果</span>
      <span
        v-for="cap in LOCAL_CAPABILITIES"
        :key="cap.key"
        class="capability-result"
        :class="resultClass(cap.key)"
      >
        {{ cap.label }}：{{ resultLabel(cap.key) }}
      </span>
    </div>
    <div v-if="checkedAt" class="modal-hint">最近检测：{{ checkedAt }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'

interface CapabilityResult {
  status?: string
  detail?: string
}

const LOCAL_CAPABILITIES = [
  { key: 'tools', label: '工具调用', resultKey: 'tools' },
  { key: 'structured_json', label: 'JSON 输出', resultKey: 'json_object' },
  { key: 'structured_schema', label: 'JSON Schema', resultKey: 'json_schema' },
  { key: 'thinking', label: '思考/推理', resultKey: 'reasoning' },
] as const

const props = defineProps({
  model: { type: Object as PropType<Record<string, any>>, required: true },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  checkedAt: { type: String, default: '' },
  results: { type: Object as PropType<Record<string, CapabilityResult>>, default: () => ({}) },
})

const emit = defineEmits<{
  toggle: [key: string, enabled: boolean]
  probe: []
}>()

const hasResults = computed(() => Object.keys(props.results).length > 0)

function resultFor(key: string) {
  const cap = LOCAL_CAPABILITIES.find(item => item.key === key)
  return cap ? props.results[cap.resultKey] : undefined
}

function resultLabel(key: string) {
  const result = resultFor(key)
  if (!result) return '未检测'
  if (result.status === '支持') return '支持'
  if (result.status === '需服务端配置') return '不支持'
  if (result.status === '未检测') return '未检测'
  return result.status || '未知'
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
  gap: 9px;
}

.capability-overrides {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, max-content));
  gap: 8px 18px;
}

.capability-override {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 20px;
  color: var(--text-primary, rgba(255, 255, 255, 0.78));
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
}

.capability-override input {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  margin: 0;
  accent-color: var(--color-primary, #7b7fb2);
}

.capability-probe {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 5px 11px;
  border: 1px solid var(--action-outline, color-mix(in srgb, var(--action-primary, #7b7fb2) 34%, transparent));
  border-radius: var(--radius-sm, 7px);
  background: var(--action-soft, color-mix(in srgb, var(--action-primary, #7b7fb2) 9%, transparent));
  color: var(--action-primary, #7b7fb2);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background var(--motion-hover-micro, 120ms) var(--motion-ease-standard, ease),
    border-color var(--motion-hover-micro, 120ms) var(--motion-ease-standard, ease),
    color var(--motion-hover-micro, 120ms) var(--motion-ease-standard, ease),
    transform var(--button-press-duration, 120ms) var(--button-press-easing, ease);
}

.capability-probe:hover:not(:disabled) {
  border-color: var(--border-hover, var(--action-primary-hover, #8e92c8));
  background: var(--action-soft-hover, color-mix(in srgb, var(--action-primary, #7b7fb2) 15%, transparent));
  color: var(--action-primary-hover, #8e92c8);
}

.capability-probe:active:not(:disabled) {
  transform: var(--button-press-transform, translateY(1px) scale(.985));
}

.capability-probe:disabled {
  opacity: var(--content-disabled-opacity, .5);
  cursor: default;
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
