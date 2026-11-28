<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Byok from './Byok.vue'
import { desktopRemoteAccount, hasRemoteAccountBridge, hasRemoteByokBridge } from '@desktop/bridge/bridge'
import type { RemoteAccountState } from '@gugu/auth/contracts'

const available = hasRemoteAccountBridge()
const { t } = useI18n()
const byokAvailable = hasRemoteByokBridge()
const account = ref<RemoteAccountState | null>(null)
const busy = ref(false)
const error = ref('')
const server = ref('')
const saas = ref(false)
const username = ref('')
const password = ref('')

async function login() {
  if (busy.value || !server.value.trim() || !username.value.trim() || !password.value) return
  const address = server.value.trim()
  const input = {
    provider: saas.value ? 'official-saas' as const : 'self-hosted' as const,
    server: saas.value && !address.includes('://') ? 'https://' + address : address,
    username: username.value.trim(), password: password.value,
  }
  password.value = ''
  await perform(() => desktopRemoteAccount.login(input))
}

async function perform(action: () => Promise<RemoteAccountState>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await action()
    account.value = result
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('pageUi.remoteOperationFailed')
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (available) void perform(desktopRemoteAccount.status)
})
</script>

<template>
  <div v-if="available" class="pm-sep"></div>
  <section v-if="available" class="pm-section account-panel" :aria-label="t('desktopSettings.login')">
    <h3 class="pm-section-label">{{ t('desktopSettings.login') }}</h3>
    <p v-if="error" class="account-error" role="alert">{{ error }}</p>
    <p v-if="!account && busy" role="status">{{ $t('pageUi.checkingRemote') }}</p>
    <ActionButton v-else-if="!account" fit variant="secondary" @click="perform(desktopRemoteAccount.status)">{{ $t('pageUi.retry') }}</ActionButton>
    <template v-else-if="account.state === 'connected' || account.state === 'offline'">
      <div class="account-summary">
        <strong v-if="account.state === 'connected'">{{ account.user.displayName || account.user.username }}</strong>
        <strong v-else>{{ $t('pageUi.remoteVerifyFailed') }}</strong>
        <span>{{ account.origin }}</span>
      </div>
      <div class="account-actions">
        <ActionButton v-if="account.state === 'offline'" fit :disabled="busy" @click="perform(desktopRemoteAccount.status)">{{ $t('pageUi.reconnect') }}</ActionButton>
        <ActionButton fit variant="secondary" :disabled="busy" @click="perform(desktopRemoteAccount.logout)">{{ $t('pageUi.signOutDevice') }}</ActionButton>
      </div>
      <section v-if="account.state === 'connected' && account.provider === 'official-saas'">
        <h4>{{ $t('pageUi.cloudProjects') }}</h4>
        <ActionButton fit variant="secondary" :disabled="busy" @click="perform(desktopRemoteAccount.status)">{{ $t('pageUi.refreshCloud') }}</ActionButton>
        <p v-if="account.projectsUnavailable" role="status">{{ $t('pageUi.cloudReadFailed') }}</p>
        <p v-else-if="!account.projects?.length">{{ $t('pageUi.noCloudProjects') }}</p>
        <ul v-else>
          <li v-for="project in account.projects" :key="project.id">
            <strong>{{ project.name }}</strong>
            <p v-if="project.summary">{{ project.summary }}</p>
          </li>
        </ul>
      </section>
      <Byok v-if="account.state === 'connected' && account.provider !== 'official-saas' && byokAvailable && !busy" :key="account.origin + account.user.id" :origin="account.origin" :account-id="account.user.id" />
    </template>
    <form v-else class="account-login" @submit.prevent="login">
      <p v-if="account.state === 'expired'" role="status">{{ $t('pageUi.remoteExpired') }}</p>
      <label><input v-model="saas" type="checkbox" :disabled="busy"> {{ $t('pageUi.saasServer') }}</label>
      <div class="account-login-field">
        <span class="pm-field-name">{{ saas ? $t('pageUi.serverAddress') : t('desktopSettings.loginServer') }}</span>
        <input v-model="server" class="form-input" :type="saas ? 'text' : 'url'" :placeholder="saas ? 'https://192.0.2.10:9595' : undefined" maxlength="2048" required :disabled="busy" :aria-label="t('desktopSettings.loginServer')" />
      </div>
      <div class="account-login-field">
        <span class="pm-field-name">{{ t('auth.usernameOrEmail') }}</span>
        <input v-model="username" class="form-input" autocomplete="username" maxlength="256" required :disabled="busy" :aria-label="t('auth.usernameOrEmail')" />
      </div>
      <div class="account-login-field">
        <span class="pm-field-name">{{ t('auth.password') }}</span>
        <input v-model="password" class="form-input" type="password" autocomplete="current-password" maxlength="4096" required :disabled="busy" :aria-label="t('auth.password')" />
      </div>
      <ActionButton fit type="submit" :disabled="busy">{{ busy ? t('auth.loggingIn') : t('auth.login') }}</ActionButton>
    </form>
  </section>
</template>

<style scoped>
.account-login { display: grid; justify-items: start; gap: var(--space-sm); }
.account-login-field { display: grid; gap: var(--space-xs); width: min(100%, 360px); min-width: 0; }
.account-panel p, .account-summary span { color: var(--text-secondary); font-size: 13px; }
.account-panel .account-error { color: var(--danger, var(--text-primary)); margin-block: 0 14px; }
.account-summary { display: grid; gap: var(--space-md); min-width: 0; }
.account-summary span { overflow-wrap: anywhere; }
.account-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-md); flex-wrap: wrap; }
</style>
