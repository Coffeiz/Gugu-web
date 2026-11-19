<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Byok from './Byok.vue'
import { desktopRemoteAccount, hasRemoteAccountBridge, hasRemoteByokBridge } from '@/desktop/bridge'
import type { RemoteAccountState } from '@gugu/core/auth/contracts'

const available = hasRemoteAccountBridge()
const byokAvailable = hasRemoteByokBridge()
const account = ref<RemoteAccountState | null>(null)
const server = ref('')
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function perform(action: () => Promise<RemoteAccountState>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await action()
    account.value = result
    if ('origin' in result) server.value = result.origin
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '远程账号操作失败，请重试'
  } finally {
    busy.value = false
  }
}

function login() {
  const input = { provider: 'self-hosted' as const, server: server.value, username: username.value, password: password.value }
  password.value = ''
  void perform(() => desktopRemoteAccount.login(input))
}

onMounted(() => {
  if (available) void perform(desktopRemoteAccount.status)
})
</script>

<template>
  <section class="account-panel glass-card" aria-labelledby="remote-account-title">
    <h1 id="remote-account-title">远程账号</h1>
    <p v-if="!available">请在咕咕桌面应用中连接自部署服务器。</p>
    <template v-else>
      <p v-if="error" class="account-error" role="alert">{{ error }}</p>
      <p v-if="!account && busy" role="status">正在检查远程会话…</p>
      <ActionButton v-else-if="!account" fit variant="secondary" @click="perform(desktopRemoteAccount.status)">重试</ActionButton>
      <template v-else-if="account.state === 'connected' || account.state === 'offline'">
        <div class="account-summary">
          <strong v-if="account.state === 'connected'">{{ account.user.displayName || account.user.username }}</strong>
          <strong v-else>暂时无法验证远程会话</strong>
          <span>{{ account.origin }}</span>
        </div>
        <div class="account-actions">
          <ActionButton v-if="account.state === 'offline'" fit :disabled="busy" @click="perform(desktopRemoteAccount.status)">重新连接</ActionButton>
          <ActionButton fit variant="secondary" :disabled="busy" @click="perform(desktopRemoteAccount.logout)">退出此设备</ActionButton>
        </div>
        <Byok v-if="account.state === 'connected' && byokAvailable && !busy" :key="account.origin + account.user.id" :origin="account.origin" :account-id="account.user.id" />
      </template>
      <form v-else class="account-form" @submit.prevent="login">
        <p v-if="account.state === 'expired'" role="status">远程会话已失效，请重新登录。</p>
        <label>
          <span>自部署服务器</span>
          <input v-model="server" required maxlength="2048" type="url" placeholder="https://gugu.example.com" autocomplete="url" :disabled="busy" aria-describedby="remote-server-help">
        </label>
        <p id="remote-server-help">服务器使用 HTTPS。本机回环地址可使用 HTTP。</p>
        <label>
          <span>账号</span>
          <input v-model="username" required maxlength="256" autocomplete="username" :disabled="busy">
        </label>
        <label>
          <span>密码</span>
          <input v-model="password" required maxlength="4096" type="password" autocomplete="current-password" :disabled="busy">
        </label>
        <div class="account-actions">
          <ActionButton fit type="submit" :disabled="busy">{{ busy ? '正在登录…' : '登录' }}</ActionButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.account-panel {
  width: min(100%, 530px);
  padding: 22px 24px;
  margin-block: 8px 24px;
  --glass-card-background-hover: var(--glass-card-background);
  --glass-card-border-hover: var(--glass-card-border);
  --glass-card-shadow-hover: var(--glass-card-shadow);
}
h1 { margin: 0 0 16px; font-size: 22px; }
.account-panel p, .account-summary span { color: var(--text-secondary); font-size: 13px; }
.account-panel .account-error { color: var(--danger, var(--text-primary)); margin-block: 0 14px; }
.account-form, .account-summary { display: grid; gap: 12px; min-width: 0; }
.account-form label { display: grid; gap: 5px; font-size: 13px; }
.account-form input { width: 100%; min-height: 36px; padding-inline: 10px; }
.account-form p { margin: -5px 0 0; }
.account-summary span { overflow-wrap: anywhere; }
.account-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
</style>
