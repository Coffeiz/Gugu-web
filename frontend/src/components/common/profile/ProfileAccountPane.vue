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

  <div v-if="prefsStore.emailChangeEnabled" class="pm-sep email-change-divider" />
  <div v-if="prefsStore.emailChangeEnabled" class="pm-section email-change-section">
    <div class="pm-section-label">{{ t('emailChangeUi.title') }}</div>
    <div class="pm-field"><label>{{ t('emailChangeUi.newEmail') }}</label><input v-model="newEmail" type="email" class="form-input" :placeholder="t('emailChangeUi.newEmailPlaceholder')" autocomplete="email" :disabled="emailSaving" /></div>
    <div class="pm-field"><label>{{ t('emailChangeUi.currentPassword') }}</label><input v-model="emailCurrentPwd" type="password" class="form-input" :placeholder="t('emailChangeUi.currentPasswordPlaceholder')" autocomplete="current-password" :disabled="emailSaving" /></div>
    <div class="pm-footer">
      <span v-if="emailMsg" class="pm-msg" :class="emailMsgType">{{ emailMsg }}</span>
      <div v-if="emailPending" class="email-change-actions">
        <button class="pm-style-chip" :disabled="emailSaving" @click="resendEmailChange">{{ emailSaving ? t('emailChangeUi.sending') : t('emailChangeUi.resend') }}</button>
        <button class="pm-style-chip" :disabled="emailSaving" @click="cancelEmailChange">{{ t('emailChangeUi.cancel') }}</button>
      </div>
      <button v-else class="pm-save-btn" :disabled="!newEmail || !emailCurrentPwd || emailSaving" @click="requestEmailChange">
        {{ emailSaving ? t('emailChangeUi.sending') : t('emailChangeUi.submit') }}
      </button>
    </div>
    <p v-if="emailPending" class="email-change-hint">{{ t('emailChangeUi.sentHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import { authApi } from '@/services/api'

const authStore = useAuthStore()
const prefsStore = usePreferencesStore()
const { t } = useI18n()
const currentPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const saving = ref(false)
const msg = ref('')
const msgType = ref('ok')
const newEmail = ref('')
const emailCurrentPwd = ref('')
const emailSaving = ref(false)
const emailPending = ref(false)
const emailMsg = ref('')
const emailMsgType = ref('ok')

onMounted(() => {
  if (!prefsStore.loaded) prefsStore.fetch()
})

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

async function requestEmailChange() {
  emailMsg.value = ''
  emailSaving.value = true
  try {
    await authApi.requestEmailChange({ newEmail: newEmail.value.trim(), currentPassword: emailCurrentPwd.value })
    emailPending.value = true
    emailMsg.value = t('emailChangeUi.sent')
    emailMsgType.value = 'ok'
    newEmail.value = emailCurrentPwd.value = ''
  } catch (error) {
    emailMsg.value = (error instanceof Error ? error.message : '') || t('emailChangeUi.failed')
    emailMsgType.value = 'err'
  } finally { emailSaving.value = false }
}

async function resendEmailChange() {
  emailMsg.value = ''
  emailSaving.value = true
  try {
    await authApi.resendEmailChange()
    emailMsg.value = t('emailChangeUi.sent')
    emailMsgType.value = 'ok'
  } catch (error) {
    emailMsg.value = (error instanceof Error ? error.message : '') || t('emailChangeUi.failed')
    emailMsgType.value = 'err'
  } finally { emailSaving.value = false }
}

async function cancelEmailChange() {
  emailSaving.value = true
  try {
    await authApi.cancelEmailChange()
    emailPending.value = false
    emailMsg.value = t('emailChangeUi.canceled')
    emailMsgType.value = 'ok'
  } catch (error) {
    emailMsg.value = (error instanceof Error ? error.message : '') || t('emailChangeUi.failed')
    emailMsgType.value = 'err'
  } finally { emailSaving.value = false }
}
</script>

<style scoped>
.email-change-section { margin-top: 0; padding-top: 14px; }
.email-change-divider { margin-top: 2px; }
.email-change-actions { display: flex; gap: 8px; justify-content: flex-end; }
.email-change-hint { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; }
</style>
