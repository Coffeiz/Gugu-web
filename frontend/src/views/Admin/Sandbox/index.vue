<template>
  <div class="sandbox-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminSandbox.title') }}</h2>
        <p class="page-desc">{{ t('adminSandbox.description') }}</p>
      </div>
      <button class="btn-primary" :disabled="loading || !canEnable" @click="toggleSandbox">
        {{ loading ? t('adminSandbox.working') : status.enabled ? t('adminSandbox.disable') : t('adminSandbox.enable') }}
      </button>
    </div>

    <section class="section-wrap">
      <div class="section-head">
        <span class="section-label">{{ t('adminSandbox.runtime') }}</span>
        <span class="section-desc">{{ t('adminSandbox.runtimeHint') }}</span>
      </div>
      <div class="panel-card">
      <div class="status-head">
        <div>
          <h3>{{ status.message || t('adminSandbox.readingDocker') }}</h3>
        </div>
        <span class="status-pill" :class="`status-${status.state}`">{{ stateLabel }}</span>
      </div>
      <div class="status-grid">
        <div><span>Docker CLI</span><strong>{{ status.docker_installed ? t('adminSandbox.installed') : t('adminSandbox.dockerMissing') }}</strong></div>
        <div><span>Docker daemon</span><strong>{{ status.docker_daemon_ready ? t('adminSandbox.ready') : t('adminSandbox.unavailable') }}</strong></div>
        <div><span>Rootless</span><strong>{{ status.rootless === true ? t('adminSandbox.enabled') : status.rootless === false ? t('adminSandbox.notEnabled') : t('adminSandbox.unknown') }}</strong></div>
        <div><span>{{ t('adminSandbox.executor') }}</span><strong>{{ status.executor_ready ? t('adminSandbox.canUse') : t('adminSandbox.cannotUse') }}</strong></div>
      </div>
      <p v-if="!canEnable && !status.enabled" class="status-note">{{ t('adminSandbox.cannotEnable') }}</p>
      <p v-if="status.enabled" class="status-note">{{ t('adminSandbox.stoppedNotice') }}</p>
      </div>
    </section>

    <section class="section-wrap">
      <div class="section-head">
        <span class="section-label">{{ t('adminSandbox.config') }}</span>
        <span class="section-desc">{{ t('adminSandbox.configHint') }}</span>
      </div>
      <div class="panel-card">
      <div class="config-row"><span>{{ t('adminSandbox.image') }}</span><code>{{ status.image }}</code></div>
      <div class="config-row"><span>{{ t('adminSandbox.digest') }}</span><code>{{ status.image_digest || t('adminSandbox.notConfigured') }}</code></div>
      <div class="config-row"><span>{{ t('adminSandbox.persistentQuota') }}</span><strong>{{ formatBytes(status.persistent_quota_bytes) }}</strong></div>
      <div class="config-row"><span>{{ t('adminSandbox.ephemeralQuota') }}</span><strong>{{ formatBytes(status.ephemeral_quota_bytes) }}</strong></div>
      <div class="config-row"><span>{{ t('adminSandbox.networkPolicy') }}</span><strong>{{ status.network_profile === 'none' ? t('adminSandbox.offline') : status.network_profile }}</strong></div>
      <div class="config-row config-row-switch">
        <div class="config-row-copy"><span>{{ t('adminSandbox.egress') }}</span><small>{{ egressHint }}</small></div>
        <ToggleSwitch :model-value="status.network_profile === 'egress'" :disabled="!status.egress_available || egressSaving" :aria-label="t('adminSandbox.switchEgress')" @update:model-value="toggleEgress" />
      </div>
      <div class="egress-editor">
        <label class="egress-label" for="egress-proxy-url">{{ t('adminSandbox.proxyAddress') }}</label>
        <div class="egress-input-row">
          <input id="egress-proxy-url" v-model="proxyDraft" class="egress-input" type="url" inputmode="url" placeholder="http://egress-proxy:3128" autocomplete="off" />
          <button type="button" class="btn-ghost" :disabled="egressSaving" @click="saveEgressProxy">{{ egressSaving ? t('adminSandbox.saving') : t('adminSandbox.saveProxy') }}</button>
          <button type="button" class="btn-ghost" :disabled="egressTesting || !status.egress_proxy_configured" @click="validateEgressProxy">{{ egressTesting ? t('adminSandbox.check') : t('adminSandbox.validate') }}</button>
        </div>
        <p class="egress-note">{{ t('adminSandbox.proxyHint') }}</p>
        <p v-if="egressMessage" class="action-message" :class="{ error: egressError }">{{ egressMessage }}</p>
      </div>
      <div class="config-row"><span>{{ t('adminSandbox.lifecycle') }}</span><strong>{{ status.lifecycle_mode === 'ephemeral' ? t('adminSandbox.oneShot') : status.lifecycle_mode }}</strong></div>
      <p class="section-note">{{ t('adminSandbox.policyHint') }}</p>
      <div class="quota-editor">
        <label><span>{{ t('adminSandbox.persistentMb') }}</span><input v-model.number="quotaDraft.persistentMb" type="number" min="64" step="64" /></label>
        <label><span>{{ t('adminSandbox.ephemeralMb') }}</span><input v-model.number="quotaDraft.ephemeralMb" type="number" min="64" step="64" /></label>
        <div class="quota-actions"><span v-if="quotaMessage" class="action-message" :class="{ error: quotaError }">{{ quotaMessage }}</span><button type="button" class="btn-ghost" :disabled="quotaSaving" @click="resetQuotaDraft">{{ t('adminSandbox.undo') }}</button><button type="button" class="btn-primary" :disabled="quotaSaving" @click="saveQuotas">{{ quotaSaving ? t('adminSandbox.saving') : t('adminSandbox.saveQuota') }}</button></div>
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
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useI18n } from 'vue-i18n'

type SandboxStatus = {
  enabled: boolean
  docker_installed: boolean
  docker_daemon_ready: boolean
  rootless: boolean | null
  image_ready: boolean
  executor_ready: boolean
  state: string
  message: string
  image: string
  image_digest: string
  persistent_quota_bytes: number
  ephemeral_quota_bytes: number
  network_profile: string
  egress_proxy_configured: boolean
  egress_proxy_url: string
  egress_network_ready: boolean
  egress_config_error: string | null
  egress_available: boolean
  egress_enabled: boolean
  lifecycle_mode: string
}

const adminStore = useAdminStore()
const { t } = useI18n()
const configStore = useConfigStore()
const loading = ref(false)
const error = ref('')
const status = reactive<SandboxStatus>({ enabled: false, docker_installed: false, docker_daemon_ready: false, rootless: null, image_ready: false, executor_ready: false, state: 'unknown', message: '', image: '', image_digest: '', persistent_quota_bytes: 0, ephemeral_quota_bytes: 0, network_profile: 'none', egress_proxy_configured: false, egress_proxy_url: '', egress_network_ready: false, egress_config_error: null, egress_available: false, egress_enabled: false, lifecycle_mode: 'ephemeral' })
const quotaDraft = reactive({ persistentMb: 512, ephemeralMb: 1024 })
const quotaSaving = ref(false)
const quotaMessage = ref('')
const quotaError = ref(false)
const egressSaving = ref(false)
const egressTesting = ref(false)
const proxyDraft = ref('')
const egressMessage = ref('')
const egressError = ref(false)
const canEnable = computed(() => status.docker_installed && status.docker_daemon_ready && status.rootless === true && status.image_ready)
const egressHint = computed(() => {
  if (status.egress_config_error) return status.egress_config_error
  if (!status.egress_proxy_configured) return t('adminSandbox.proxyNotConfigured')
  if (!status.egress_network_ready) return t('adminSandbox.networkNotReady')
  return status.network_profile === 'egress' ? t('adminSandbox.egressEnabled') : t('adminSandbox.egressAvailable')
})
const stateLabel = computed(() => ({ ready: t('adminSandbox.ready'), disabled: t('adminSandbox.disabled'), docker_missing: t('adminSandbox.dockerMissing'), docker_unavailable: t('adminSandbox.dockerUnavailable'), rootless_required: t('adminSandbox.rootlessRequired'), image_unavailable: t('adminSandbox.imageUnavailable') } as Record<string, string>)[status.state] || t('adminSandbox.unknown'))
function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${Math.round(value / (1024 * 1024))} MB`
}
function syncQuotaDraft() {
  quotaDraft.persistentMb = Math.round((configStore.cfg.sandbox.persistent_quota_bytes || status.persistent_quota_bytes) / (1024 * 1024))
  quotaDraft.ephemeralMb = Math.round((configStore.cfg.sandbox.ephemeral_quota_bytes || status.ephemeral_quota_bytes) / (1024 * 1024))
}
function resetQuotaDraft() { syncQuotaDraft(); quotaMessage.value = ''; quotaError.value = false }
async function saveQuotas() {
  quotaSaving.value = true; quotaMessage.value = ''; quotaError.value = false
  try {
    if (quotaDraft.persistentMb < 64 || quotaDraft.ephemeralMb < 64) throw new Error(t('adminSandbox.quotaTooSmall'))
    await configStore.saveConfig({ sandbox: { persistent_quota_bytes: quotaDraft.persistentMb * 1024 * 1024, ephemeral_quota_bytes: quotaDraft.ephemeralMb * 1024 * 1024 } })
    await loadStatus()
    syncQuotaDraft()
    quotaMessage.value = t('adminSandbox.saved')
  } catch (cause) { quotaError.value = true; quotaMessage.value = cause instanceof Error ? cause.message : String(cause) }
  finally { quotaSaving.value = false }
}
async function toggleEgress(enabled: boolean) {
  egressSaving.value = true
  try {
    await configStore.saveConfig({ sandbox: { network_profile: enabled ? 'egress' : 'none' } })
    await loadStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { egressSaving.value = false }
}

async function saveEgressProxy() {
  egressSaving.value = true
  egressMessage.value = ''
  egressError.value = false
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/egress/config', {
      method: 'POST',
      body: JSON.stringify({ proxy_url: proxyDraft.value.trim() }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `保存代理失败（${response.status}）`)
    Object.assign(status, body)
    proxyDraft.value = body.egress_proxy_url || ''
    egressMessage.value = t('adminSandbox.proxySaved')
  } catch (cause) {
    egressError.value = true
    egressMessage.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    egressSaving.value = false
  }
}

async function validateEgressProxy() {
  egressTesting.value = true
  egressMessage.value = ''
  egressError.value = false
  try {
    const response = await adminStore.authFetch('/api/v1/admin/sandbox/egress/validate', { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `验证代理失败（${response.status}）`)
    egressMessage.value = body.message || t('adminSandbox.proxyValid')
  } catch (cause) {
    egressError.value = true
    egressMessage.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    egressTesting.value = false
  }
}

async function loadStatus() {
  const response = await adminStore.authFetch('/api/v1/admin/sandbox/status')
  if (!response.ok) throw new Error(`读取沙盒状态失败（${response.status}）`)
  Object.assign(status, await response.json())
  proxyDraft.value = status.egress_proxy_url || ''
}

async function toggleSandbox() {
  loading.value = true; error.value = ''
  try {
    const action = status.enabled ? 'disable' : 'enable'
    const response = await adminStore.authFetch(`/api/v1/admin/sandbox/${action}`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `操作失败（${response.status}）`)
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
.btn-primary, .btn-ghost { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex-shrink: 0; min-height: 30px; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; line-height: 1.2; white-space: nowrap; cursor: pointer; }
.btn-primary { margin-top: 1px; border: 0; background: var(--action-primary-bg); color: var(--content-on-accent); font-weight: 600; }
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
.btn-ghost { border: 1px solid var(--border-subtle); background: var(--surface-glass); color: var(--content-secondary); }
.btn-ghost:hover:not(:disabled) { background: var(--surface-glass-hover); color: var(--content-primary); }
.btn-primary:disabled, .btn-ghost:disabled { cursor: default; opacity: .5; }
.section-wrap { padding: 20px 36px 0; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.section-label { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.section-desc { color: var(--content-tertiary); font-size: 12px; }
.panel-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); background: var(--panel-glass-bg); box-shadow: var(--elevation-card); color: var(--content-primary); backdrop-filter: var(--panel-glass-blur); -webkit-backdrop-filter: var(--panel-glass-blur); }
.status-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h3 { margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; }
.status-pill { flex-shrink: 0; padding: 5px 10px; border-radius: var(--radius-pill); background: var(--surface-muted); color: var(--content-secondary); font-size: 12px; }
.status-ready { background: color-mix(in srgb, var(--status-success) 12%, transparent); color: var(--status-success); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
.status-grid div { padding: 12px; border: 1px solid var(--panel-divider); border-radius: var(--radius-sm); background: var(--surface-glass); }
.status-grid span, .config-row span { display: block; color: var(--content-tertiary); font-size: 12px; }
.status-grid strong { display: block; margin-top: 6px; color: var(--content-primary); font-size: 14px; font-weight: 600; }
.section-note, .status-note { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.6; }
.config-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--panel-divider); }
.config-row:last-of-type { border-bottom: 0; }
.config-row strong { color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.config-row-switch { align-items: center; }
.config-row-copy { min-width: 0; }
.config-row-copy small { display: block; margin-top: 4px; color: var(--content-tertiary); font-size: 11px; line-height: 1.4; }
.config-row code { max-width: 72%; overflow: hidden; color: var(--content-secondary); font-family: var(--font-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.egress-editor { padding: 14px 0 4px; border-bottom: 1px solid var(--panel-divider); }
.egress-label { display: block; margin-bottom: 8px; color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.egress-input-row { display: flex; align-items: center; gap: 8px; }
.egress-input { min-width: 0; flex: 1; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-primary); font-family: var(--font-mono); font-size: 12px; outline: none; }
.egress-input:focus { border-color: var(--action-primary); box-shadow: var(--control-focus-shadow); }
.egress-note { margin: 8px 0 0; color: var(--content-tertiary); font-size: 11px; line-height: 1.5; }
.quota-editor { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--panel-divider); }
.quota-editor label { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; color: var(--content-secondary); font-size: 12px; }
.quota-editor input { width: 150px; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-primary); outline: none; }
.quota-editor input:focus { border-color: var(--action-primary); }
.quota-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.action-message { margin-right: auto; color: var(--status-success); font-size: 12px; }
.action-message.error { color: var(--status-danger); }
.error-message { margin: 16px 36px 0; color: var(--status-danger); font-size: 12px; }
@media (max-width: 760px) { .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .page-header { padding-left: 20px; padding-right: 20px; } .section-wrap { padding-left: 20px; padding-right: 20px; } .error-message { margin-left: 20px; margin-right: 20px; } }
@media (max-width: 520px) { .page-header { flex-direction: column; gap: 12px; } .btn-primary { align-self: flex-start; } }
@media (max-width: 620px) { .egress-input-row { align-items: stretch; flex-wrap: wrap; } .egress-input { flex-basis: 100%; } }
</style>
