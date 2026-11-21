<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Byok from './Byok.vue'
import { desktopRemoteAccount, hasRemoteAccountBridge, hasRemoteByokBridge } from '@desktop/bridge/bridge'
import type { RemoteAccountState } from '@gugu/core/auth/contracts'

const available = hasRemoteAccountBridge()
const byokAvailable = hasRemoteByokBridge()
const account = ref<RemoteAccountState | null>(null)
const busy = ref(false)
const error = ref('')

async function perform(action: () => Promise<RemoteAccountState>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await action()
    account.value = result
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '远程账号操作失败，请重试'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  if (available) void perform(desktopRemoteAccount.status)
})
</script>

<template>
  <section class="account-panel" aria-label="远程账号">
    <p v-if="!available">桌面预览未连接远程账号 IPC。</p>
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
      <p v-else role="status">{{ account.state === 'expired' ? '远程会话已失效。' : '尚未连接远程账号。' }} 当前版本仅提供桌面账号状态接口。</p>
    </template>
  </section>
</template>

<style scoped>
.account-panel { padding: 18px 26px; }
.account-panel p, .account-summary span { color: var(--text-secondary); font-size: 13px; }
.account-panel .account-error { color: var(--danger, var(--text-primary)); margin-block: 0 14px; }
.account-summary { display: grid; gap: 12px; min-width: 0; }
.account-summary span { overflow-wrap: anywhere; }
.account-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
</style>
