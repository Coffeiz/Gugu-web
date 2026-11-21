<template>
  <div class="sandbox-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminSandbox.title') }}</h2>
        <p class="page-desc">{{ t('adminSandbox.description') }}</p>
      </div>
      <ActionButton v-if="!status.enabled" fit :disabled="!canEnable || loading" @click="enableSandbox">
        {{ loading ? t('adminSandbox.working') : t('adminSandbox.enable') }}
      </ActionButton>
      <ActionButton v-else fit :disabled="loading" @click="disableSandbox">
        {{ loading ? t('adminSandbox.working') : t('adminSandbox.disable') }}
      </ActionButton>
    </div>

    <SandboxRuntimeStatus :status="status" :offline-only="offlineOnly" />

    <section class="sandbox-config-section">
      <div class="sandbox-config-section__head">
        <span class="sandbox-config-section__label">{{ t('adminSandbox.config') }}</span>
        <span class="sandbox-config-section__desc">{{ t('adminSandbox.configHint') }}</span>
      </div>
      <div class="panel-card">
      <div v-if="configStore.cfg.storage.backend === 'oss'" class="config-row"><span>{{ t('adminSandbox.persistentQuota') }}</span><strong>{{ formatBytes(configStore.cfg.sandbox.persistent_quota_bytes) }}</strong></div>
      <div class="config-row"><span>{{ t('adminSandbox.ephemeralQuota') }}</span><strong>{{ formatBytes(configStore.cfg.sandbox.ephemeral_quota_bytes) }}</strong></div>
      <SandboxNetworkPolicy v-if="statusLoaded && offlineOnly" ref="networkPolicy" :saving="quotaSaving" />
      <div v-else class="config-row"><span>{{ t('adminSandbox.networkPolicy') }}</span><strong>{{ status.network_profile === 'none' ? t('adminSandbox.offline') : status.network_profile }}</strong></div>
      <div class="config-row config-row-switch">
        <div class="config-row-copy"><span>{{ t('adminSandbox.fullUserSandboxAuthorization') }}</span><small>{{ t('adminSandbox.fullUserSandboxAuthorizationHint') }}</small></div>
        <ToggleSwitch :model-value="configStore.cfg.sandbox.full_user_sandbox_authorization_enabled" :disabled="fullUserSandboxAuthorizationSaving" :aria-label="t('adminSandbox.fullUserSandboxAuthorization')" @update:model-value="toggleFullUserSandboxAuthorization" />
      </div>
      <SystemShellSetting v-if="statusLoaded" />
      <div class="config-row terminal-mode-row">
        <div class="config-row-copy"><span>{{ t('adminSandbox.terminalMode') }}</span><small>{{ t('adminSandbox.terminalModeHint', { entry: terminalModeDraft !== 'entry_disabled' ? t('adminSandbox.enabled') : t('adminSandbox.disabled') }) }}</small></div>
        <AdminSelect
          :model-value="terminalModeDraft"
          :options="terminalModeOptions"
          :placeholder="t('adminSandbox.terminalModeAuto')"
          :disabled="terminalModeSaving"
          :aria-label="t('adminSandbox.terminalMode')"
          @update:model-value="saveTerminalMode"
        />
      </div>
      <SandboxEgressControls v-if="statusLoaded && !offlineOnly" :status="status" :offline-only="offlineOnly" :reload-status="loadStatus" />
      <div class="quota-editor">
        <div v-if="configStore.cfg.storage.backend === 'oss'" class="quota-field"><span>{{ t('adminSandbox.persistentMb') }}</span><input v-model.number="quotaDraft.persistentMb" type="number" min="64" step="64" :aria-label="t('adminSandbox.persistentMb')" /></div>
        <div class="quota-field"><span>{{ t('adminSandbox.ephemeralMb') }}</span><input v-model.number="quotaDraft.ephemeralMb" type="number" min="64" step="64" :aria-label="t('adminSandbox.ephemeralMb')" /></div>
        <div class="quota-actions"><span v-if="quotaMessage" class="action-message" :class="{ error: quotaError }">{{ quotaMessage }}</span><ActionButton variant="secondary" fit :disabled="quotaSaving" @click="resetQuotaDraft">{{ t('adminSandbox.undo') }}</ActionButton><ActionButton fit :disabled="quotaSaving" @click="saveQuotas">{{ quotaSaving ? t('adminSandbox.saving') : t('adminSandbox.saveRuntimeConfig') }}</ActionButton></div>
      </div>
      </div>
    </section>

    <p v-if="error" class="error-message">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { useConfigStore } from '@/stores/config'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import SandboxRuntimeStatus from './components/SandboxRuntimeStatus.vue'
import SystemShellSetting from './components/SystemShellSetting.vue'
import SandboxNetworkPolicy from './components/SandboxNetworkPolicy.vue'
import SandboxEgressControls from './components/SandboxEgressControls.vue'
import { isOfflineOnly, type SandboxStatus } from './sandbox-status'
import { useI18n } from 'vue-i18n'

const adminStore = useAdminStore()
const { t } = useI18n()
const configStore = useConfigStore()
const loading = ref(false)
const error = ref('')
const status = reactive<SandboxStatus>({ enabled: true, sandbox_ready: false, runtime_supported: false, runtime_methods: [], readiness_checked: false, shell_enabled: false, shell_dangerous_enabled: false, state: 'unknown', message: '', network_profile: 'none', egress_proxy_configured: false, egress_proxy_url: '', egress_network_ready: false, egress_config_error: null, egress_available: false, egress_enabled: false })
const quotaDraft = reactive({ persistentMb: 512, ephemeralMb: 1024 })
const quotaSaving = ref(false)
const networkPolicy = ref<InstanceType<typeof SandboxNetworkPolicy> | null>(null)
const quotaMessage = ref('')
const quotaError = ref(false)
const fullUserSandboxAuthorizationSaving = ref(false)
const terminalModeSaving = ref(false)
const terminalModeDraft = ref<'auto' | 'pty_disabled' | 'entry_disabled'>('auto')
const terminalModeOptions = computed(() => [
  { value: 'auto', label: t('adminSandbox.terminalModeAuto') },
  { value: 'pty_disabled', label: t('adminSandbox.terminalModePtyDisabled') },
  { value: 'entry_disabled', label: t('adminSandbox.terminalModeEntryDisabled') },
])
const statusLoaded = ref(false)
const offlineOnly = computed(() => isOfflineOnly(status))
const canEnable = computed(() => status.runtime_supported && status.sandbox_ready)
function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${Math.round(value / (1024 * 1024))} MB`
}
function syncQuotaDraft() {
  quotaDraft.persistentMb = Math.round(configStore.cfg.sandbox.persistent_quota_bytes / (1024 * 1024))
  quotaDraft.ephemeralMb = Math.round(configStore.cfg.sandbox.ephemeral_quota_bytes / (1024 * 1024))
}
function resetQuotaDraft() { networkPolicy.value?.reset(); syncQuotaDraft(); quotaMessage.value = ''; quotaError.value = false }
async function saveQuotas() {
  quotaSaving.value = true; quotaMessage.value = ''; quotaError.value = false
  try {
    if (quotaDraft.persistentMb < 64 || quotaDraft.ephemeralMb < 64) throw new Error(t('adminSandbox.quotaTooSmall'))
    const policy = networkPolicy.value?.draft()
    await configStore.saveConfig({ sandbox: {
      ...(configStore.cfg.storage.backend === 'oss' ? { persistent_quota_bytes: quotaDraft.persistentMb * 1024 * 1024 } : {}),
      ephemeral_quota_bytes: quotaDraft.ephemeralMb * 1024 * 1024,
      ...(policy ? { direct_network_policy: policy } : {}),
    } })
    if (configStore.saveError) throw new Error(configStore.saveError)
    if (policy) networkPolicy.value?.commit(policy)
    await loadStatus()
    syncQuotaDraft()
    quotaMessage.value = t('adminSandbox.saved')
  } catch (cause) { quotaError.value = true; quotaMessage.value = cause instanceof Error ? cause.message : String(cause) }
  finally { quotaSaving.value = false }
}
async function toggleFullUserSandboxAuthorization(enabled: boolean) {
  const previousValue = configStore.cfg.sandbox.full_user_sandbox_authorization_enabled
  fullUserSandboxAuthorizationSaving.value = true
  try {
    await configStore.saveConfig({ sandbox: {
      full_user_sandbox_authorization_enabled: enabled,
    } })
    if (configStore.saveError) throw new Error(configStore.saveError)
    await loadStatus()
  } catch (cause) {
    configStore.cfg.sandbox.full_user_sandbox_authorization_enabled = previousValue
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    fullUserSandboxAuthorizationSaving.value = false
  }
}

async function saveTerminalMode(value: 'auto' | 'pty_disabled' | 'entry_disabled') {
  terminalModeDraft.value = value
  terminalModeSaving.value = true
  try {
    await configStore.saveConfig({ sandbox: { terminal_mode: terminalModeDraft.value } })
    if (configStore.saveError) throw new Error(configStore.saveError)
    await loadStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    terminalModeDraft.value = configStore.cfg.sandbox.terminal_mode
  } finally {
    terminalModeSaving.value = false
  }
}

async function loadStatus() {
  const response = await adminStore.authFetch('/api/v1/admin/sandbox/status')
  if (!response.ok) throw new Error(`读取沙盒状态失败（${response.status}）`)
  Object.assign(status, await response.json())
  statusLoaded.value = true
  terminalModeDraft.value = configStore.cfg.sandbox.terminal_mode
}

async function enableSandbox() {
  loading.value = true
  error.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/enable', { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `开启执行环境失败（${response.status}）`)
    Object.assign(status, body)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

async function disableSandbox() {
  if (!await confirmDialog({ title: t('adminSandbox.disableTitle'), message: t('adminSandbox.disableMessage'), tone: 'danger', confirmText: t('adminSandbox.disable') })) return
  loading.value = true
  error.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/disable', { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `关闭执行环境失败（${response.status}）`)
    Object.assign(status, body)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { loading.value = false }
}

onMounted(async () => {
  try { await configStore.fetchConfig(); await loadStatus(); syncQuotaDraft() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
})
</script>

<style scoped>
.sandbox-page { min-height: 100%; padding-bottom: 32px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title { margin: 0; color: var(--content-primary); font-size: 22px; font-weight: 700; line-height: 1.2; }
.page-desc { margin-top: 6px; color: var(--content-tertiary); font-size: 12px; }
.sandbox-config-section { min-width: 0; padding: 20px 36px 0; }
.sandbox-config-section__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; min-width: 0; margin-bottom: 10px; }
.sandbox-config-section__label { flex: 0 0 auto; color: var(--content-primary); font-size: 13px; font-weight: 600; }
.sandbox-config-section__desc { flex: 1 1 280px; min-width: 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.panel-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--card-radius); background: var(--panel-glass-bg); box-shadow: var(--elevation-card); color: var(--content-primary); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.config-row span { display: block; color: var(--content-tertiary); font-size: 12px; }
.config-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--panel-divider); }
.config-row:last-of-type { border-bottom: 0; }
.config-row strong { color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.config-row-switch { align-items: center; }
/* 保存期间仍禁止重复点击，但保留开关的即时状态，不用 disabled 的半透明效果覆盖反馈。 */
.config-row-switch :deep(.toggle-switch:disabled) { opacity: 1; }
.config-row-copy { min-width: 0; }
.config-row-copy small { display: block; margin-top: 4px; color: var(--content-tertiary); font-size: 11px; line-height: 1.4; }
.config-row code { max-width: 72%; overflow: hidden; color: var(--content-secondary); font-family: var(--font-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.quota-editor { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--panel-divider); }
.terminal-mode-row + .quota-editor { margin-top: 0; border-top: 0; }
.quota-editor .quota-field { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; color: var(--content-secondary); font-size: 12px; }
.quota-editor input { width: 150px; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); background: var(--surface-glass); color: var(--content-primary); outline: none; }
.quota-editor input:focus { border-color: var(--action-primary); }
.quota-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.action-message { margin-right: auto; color: var(--status-success); font-size: 12px; }
.action-message.error { color: var(--status-danger); }
.error-message { margin: 16px 36px 0; color: var(--status-danger); font-size: 12px; }
@media (max-width: 760px) { .page-header { padding-left: 20px; padding-right: 20px; } .section-wrap, .sandbox-config-section { padding-left: 20px; padding-right: 20px; } .error-message { margin-left: 20px; margin-right: 20px; } }
@media (max-width: 520px) { .page-header { flex-direction: column; gap: 12px; } .page-header .app-action-button { align-self: flex-start; } }
</style>
