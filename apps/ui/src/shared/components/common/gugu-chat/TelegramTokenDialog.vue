<template>
  <BaseModal :show="show" width="460px" background="var(--panel-bg)" teleport-to="body" @close="emit('close')">
    <form class="telegram-token-dialog" :class="{ 'is-binding': bindingStep }" @submit.prevent="submit">
      <div class="telegram-token-heading">
        <div>
          <h2>{{ t(bindingStep ? 'profileImUi.telegramBinding' : 'chatUi.telegramConnectTitle') }}</h2>
          <p>{{ t(bindingStep ? 'profileImUi.telegramBindingHint' : 'chatUi.telegramTokenHint') }}</p>
        </div>
        <CloseButton card-corner @click="emit('close')" />
      </div>

      <div v-if="bindingStep" class="telegram-token-field">
        <ImBindingCode v-if="binding && binding.expiresIn > 0" :binding="binding" telegram expanded @copy-failed="copyError = true" />
        <span v-else-if="binding">{{ t('profileImUi.codeExpired') }}</span>
        <ActionButton v-if="!binding || binding.expiresIn <= 0" type="button" fit :disabled="busy" @click="emit('generate')">
          {{ t(busy ? 'profileImUi.generating' : 'profileImUi.generateCode') }}
        </ActionButton>
      </div>
      <div v-else class="telegram-token-field">
        <span class="telegram-token-label">{{ t('profileImUi.telegramTokenLabel') }}</span>
        <input
          ref="tokenInput"
          v-model="token"
          class="form-input"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :aria-label="t('profileImUi.telegramTokenLabel')"
          :placeholder="t('profileImUi.telegramTokenPlaceholder')"
          :disabled="busy"
        />
        <p class="telegram-token-security">{{ t('profileImUi.telegramTokenSecurityHint') }}</p>
      </div>

      <p v-if="error || copyError" class="telegram-token-error" role="alert">{{ error || t('profileImUi.copyFailed') }}</p>

      <div v-if="!bindingStep" class="telegram-token-actions app-card-actions">
        <ActionButton variant="secondary" fit :disabled="busy" @click="emit('close')">
          {{ t('common.actions.cancel') }}
        </ActionButton>
        <ActionButton type="submit" fit :disabled="busy || !token.trim()">
          {{ busy ? t('profileImUi.connectingTelegram') : t('profileImUi.connectTelegram') }}
        </ActionButton>
      </div>
    </form>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'

import ImBindingCode from '@/im/connect/ImBindingCode.vue'
import type { TelegramBindingStep } from './composables/useChatImConnect'

const props = defineProps<{ show: boolean; busy: boolean; error: string; bindingStep?: TelegramBindingStep }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'generate'): void; (event: 'submit', token: string): void }>()
const { t } = useI18n()
const copyError = ref(false)
const now = ref(Date.now())
const binding = computed(() => {
  const code = props.bindingStep?.code
  return code && { code: code.code, expiresIn: Math.max(0, Math.ceil((code.expiresAt - now.value) / 1000)) }
})
watch(() => props.show ? props.bindingStep?.code?.expiresAt : undefined, (expiresAt, _, cleanup) => {
  copyError.value = false
  if (!expiresAt) return
  now.value = Date.now()
  const timer = setInterval(() => {
    now.value = Date.now()
    if (now.value >= expiresAt) clearInterval(timer)
  }, 1000)
  cleanup(() => clearInterval(timer))
})
const token = ref('')
const tokenInput = ref<HTMLInputElement | null>(null)

watch(() => props.show, async (show) => {
  if (!show) {
    token.value = ''
    return
  }
  await nextTick()
  tokenInput.value?.focus()
})

function submit() {
  const value = token.value.trim()
  if (!value || props.busy || props.bindingStep) return
  token.value = ''
  emit('submit', value)
}
</script>

<style scoped>
.telegram-token-dialog { display:flex; flex-direction:column; gap:var(--space-lg); --card-actions-inset: var(--space-xl); padding: var(--space-xl) var(--card-actions-inset) 0; }
.telegram-token-dialog.is-binding { padding-bottom: var(--space-xl); gap: var(--space-md); }
.telegram-token-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-md); }
.telegram-token-heading h2 { margin:0; color:var(--content-primary); font-size:var(--font-size-lg); font-weight:var(--font-weight-semibold); }
.telegram-token-heading p { margin:var(--space-xs) 0 0; color:var(--content-secondary); font-size:var(--font-size-sm); line-height:var(--line-height-body); }
.telegram-token-field { display:flex; flex-direction:column; gap:var(--space-xs); }
.telegram-token-label { color:var(--content-secondary); font-size:var(--font-size-sm); font-weight:var(--font-weight-medium); }
.telegram-token-security { margin:0; color:var(--content-tertiary); font-size:var(--font-size-xs); line-height:var(--line-height-body); }
.telegram-token-error { margin:0; color:var(--status-danger); font-size:var(--font-size-sm); }
.telegram-token-actions { display:flex; justify-content:flex-end; gap:var(--space-sm); }
</style>
