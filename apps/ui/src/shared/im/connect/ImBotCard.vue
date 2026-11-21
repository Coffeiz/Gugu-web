<script setup lang="ts">
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useI18n } from 'vue-i18n'

defineProps<{ name: string; detail?: string; enabled: boolean; busy?: boolean; sandbox?: boolean; status?: string }>()
defineEmits<{ toggle: [enabled: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <div class="pm-bot-item">
    <div class="pm-bot-item-top">
      <div class="pm-bot-info">
        <span class="pm-bot-name">
          {{ name }}<span v-if="sandbox" class="pm-bot-tag">{{ t('profileImUi.sandbox') }}</span>
        </span>
        <span v-if="detail" class="pm-bot-appid">{{ detail }}</span>
        <span v-if="status" class="pm-field-hint" role="status">{{ status }}</span>
      </div>
      <span class="pm-switch-wrap">
        <ToggleSwitch size="sm" :model-value="enabled" :disabled="busy"
          :aria-label="t(enabled ? 'profileImUi.disableBot' : 'profileImUi.enableBot')"
          @update:model-value="$emit('toggle', $event)" />
        <span class="pm-switch-label" :class="{ on: enabled }">{{ t(enabled ? 'profileImUi.enabled' : 'profileImUi.disabled') }}</span>
      </span>
      <slot name="actions" />
    </div>
    <slot />
  </div>
</template>
