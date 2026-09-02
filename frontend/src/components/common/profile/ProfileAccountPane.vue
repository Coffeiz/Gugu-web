<template>
  <div class="pm-section">
    <div class="pm-section-label">{{ t('profileAccountUi.changePassword') }}</div>
    <div class="pm-field"><label>{{ t('profileAccountUi.currentPassword') }}</label><input v-model="currentPwd" type="password" class="form-input" placeholder="••••••••" /></div>
    <div class="pm-field"><label>{{ t('profileAccountUi.newPassword') }}</label><input v-model="newPwd" type="password" class="form-input" :placeholder="t('profileAccountUi.minPassword')" /></div>
    <div class="pm-field"><label>{{ t('profileAccountUi.confirmPassword') }}</label><input v-model="confirmPwd" type="password" class="form-input" :placeholder="t('profileAccountUi.enterAgain')" /></div>
    <div class="pm-footer">
      <span v-if="msg" class="pm-msg" :class="msgType">{{ msg }}</span>
      <button class="pm-save-btn" :disabled="!currentPwd || !newPwd || !confirmPwd || saving" @click="save">
        {{ saving ? t('sharedUi.saving') : t('profileAccountUi.changePassword') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const { t } = useI18n()
const currentPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const saving = ref(false)
const msg = ref('')
const msgType = ref('ok')

async function save() {
  msg.value = ''
  if (newPwd.value.length < 6) { msg.value = t('profileAccountUi.passwordTooShort'); msgType.value = 'err'; return }
  if (newPwd.value !== confirmPwd.value) { msg.value = t('profileAccountUi.passwordMismatch'); msgType.value = 'err'; return }
  saving.value = true
  try {
    await authStore.updateProfile({ currentPassword: currentPwd.value, newPassword: newPwd.value })
    msg.value = t('profileAccountUi.passwordUpdated')
    msgType.value = 'ok'
    currentPwd.value = newPwd.value = confirmPwd.value = ''
  } catch (error) {
    msg.value = (error instanceof Error ? error.message : '') || t('profileAccountUi.changeFailed')
    msgType.value = 'err'
  } finally {
    saving.value = false
  }
}
</script>
