<template>
  <div class="behavior-item">
    <div class="behavior-label">
      <span>{{ t('agentParallelUi.label') }}</span>
      <span class="behavior-desc">{{ t('agentParallelUi.hint') }}</span>
    </div>
    <div class="control-status">
      <div class="limit-control">
        <span>{{ t('agentParallelUi.limit') }}</span>
        <input
          class="form-input limit-input"
          :value="props.maxConcurrency"
          type="number"
          min="1"
          max="20"
          step="1"
          :aria-label="t('agentParallelUi.limit')"
          @change="emit('update:maxConcurrency', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <ToggleSwitch
        :model-value="props.modelValue"
        :aria-label="t('agentParallelUi.label')"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'

const props = defineProps<{
  modelValue: boolean
  maxConcurrency: number
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'update:maxConcurrency', value: number): void
}>()
const { t } = useI18n()
</script>

<style scoped>
.behavior-item { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 0; border-bottom:1px solid var(--panel-divider); }
.behavior-label { display:flex; flex-direction:column; gap:3px; min-width:0; }
.behavior-label>span:first-child { font-size:13px; font-weight:500; color:var(--content-primary); }
.behavior-desc { color:var(--content-tertiary); font-size:12px; line-height:1.5; }
.control-status { display:flex; align-items:center; gap:10px; flex-shrink:0; }
.limit-control { display:flex; align-items:center; gap:8px; color:var(--content-secondary); font-size:12px; white-space:nowrap; }
.limit-control .limit-input { width:64px; min-height:32px; padding:5px 8px; text-align:center; }
@media(max-width:720px) { .behavior-item { align-items:flex-start; } }
</style>
