<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const props = defineProps({ busy: Boolean, replacing: Boolean })
const token = defineModel<string>({ required: true })
const emit = defineEmits<{ submit: []; cancel: [] }>()
const { t } = useI18n()

function submit() {
  if (!props.busy && token.value.trim()) emit('submit')
}
</script>

<template>
  <form class="pm-telegram-connect" @submit.prevent="submit">
    <span class="pm-field-name">{{ t('profileImUi.telegramTokenLabel') }}</span>
    <div class="pm-telegram-token-controls">
      <input id="telegram-bot-token" v-model="token" class="form-input" type="password"
        autocomplete="new-password" :aria-label="t('profileImUi.telegramTokenLabel')"
        :placeholder="t('profileImUi.telegramTokenPlaceholder')" :disabled="busy" />
      <button class="pm-style-chip" type="submit" :disabled="busy || !token.trim()">
        {{ t(busy ? 'profileImUi.connectingTelegram' : replacing ? 'profileImUi.replaceTelegramToken' : 'profileImUi.connectTelegram') }}
      </button>
      <button class="pm-style-chip" type="button" :disabled="busy" @click="emit('cancel')">{{ t('profileImUi.cancel') }}</button>
    </div>
    <p class="pm-field-hint">{{ t('profileImUi.telegramTokenSecurityHint') }}</p>
  </form>
</template>

<style scoped>
.pm-telegram-connect {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin: var(--space-sm) 0 var(--space-xs);
  padding: var(--space-md);
  border: 1px solid var(--subpanel-border);
  border-radius: var(--radius-xs);
  background: var(--subpanel-bg);
}

.pm-telegram-token-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-sm);
}

.pm-telegram-token-controls input {
  flex: 1 1 240px;
  min-width: 0;
}

.pm-telegram-connect > .pm-field-hint {
  margin: 0;
}
</style>
