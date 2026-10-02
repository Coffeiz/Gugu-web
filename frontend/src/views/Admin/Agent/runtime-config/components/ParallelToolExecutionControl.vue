<template>
  <div class="behavior-item">
    <div class="behavior-label">
      <span>{{ t('agentParallelUi.label') }}</span>
      <span class="behavior-desc">{{ t('agentParallelUi.hint') }}</span>
    </div>
    <div class="control-status">
      <span v-if="error" class="status-text status-error" role="status">{{ error }}</span>
      <span v-else-if="saved" class="status-text" role="status">{{ t('agent.saved') }}</span>
      <ToggleSwitch
        :model-value="modelValue"
        :disabled="saving"
        :aria-label="t('agentParallelUi.label')"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'

defineProps<{
  modelValue: boolean
  saving: boolean
  saved: boolean
  error: string
}>()

const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()
const { t } = useI18n()
</script>

<style scoped>
.behavior-item { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 0; border-bottom:1px solid var(--panel-divider); }
.behavior-label { display:flex; flex-direction:column; gap:3px; min-width:0; }
.behavior-label>span:first-child { font-size:13px; font-weight:500; color:var(--content-primary); }
.behavior-desc { color:var(--content-tertiary); font-size:12px; line-height:1.5; }
.control-status { display:flex; align-items:center; gap:10px; flex-shrink:0; }
.status-text { color:var(--status-success); font-size:12px; }
.status-error { max-width:280px; color:var(--status-danger); overflow-wrap:anywhere; }
@media(max-width:720px) { .behavior-item { align-items:flex-start; } }
</style>
