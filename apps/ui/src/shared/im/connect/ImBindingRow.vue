<script setup lang="ts">
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import ImBindingCode from './ImBindingCode.vue'

defineProps({
  bound: Boolean,
  busy: Boolean,
  telegram: Boolean,
  binding: Object as PropType<{ code: string; expiresIn: number }>,
})
const emit = defineEmits<{ generate: []; copyFailed: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="pm-bot-group-row">
    <div class="pm-field-desc">
      <span class="pm-field-name">{{ t(telegram ? 'profileImUi.telegramBinding' : 'profileImUi.qqBinding') }}</span>
      <span class="pm-field-hint">{{ t(telegram ? 'profileImUi.telegramBindingHint' : 'profileImUi.qqBindingHint') }}</span>
    </div>
    <div class="pm-binding-code">
      <button v-if="!bound && (!binding || binding.expiresIn <= 0)" type="button" class="pm-style-chip"
        :disabled="busy" @click="emit('generate')">{{ t(busy ? 'profileImUi.generating' : 'profileImUi.generateCode') }}</button>
      <ImBindingCode v-if="binding && binding.expiresIn > 0" :binding="binding" :telegram="telegram" @copy-failed="emit('copyFailed')" />
      <span v-else-if="bound" class="pm-field-hint">{{ t('profileImUi.bound') }}</span>
      <span v-else-if="binding" class="pm-field-hint">{{ t('profileImUi.codeExpired') }}</span>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.pm-binding-code {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  min-width: 0;
}
</style>
