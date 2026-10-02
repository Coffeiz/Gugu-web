<template>
  <div class="pm-bot-group-row pm-bot-tools-row">
    <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileImUi.groupOwnerMemory') }}</span><span class="pm-field-hint">{{ t('profileImUi.groupOwnerMemoryHint') }}</span></div>
    <span class="pm-switch-wrap"><ToggleSwitch size="sm" :model-value="enabled" :aria-label="t('profileImUi.groupOwnerMemory')" @update:model-value="change" /></span>
  </div>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
defineProps({ enabled: { type: Boolean, default: false } })
const emit = defineEmits<{ change: [value: boolean] }>()
const { t } = useI18n()
async function change(value: boolean) {
  if (value && !await confirmDialog({ title: t('profileImUi.groupOwnerMemory'), message: t('profileImUi.groupOwnerMemoryWarning'), tone: 'warning' })) return
  emit('change', value)
}
</script>
