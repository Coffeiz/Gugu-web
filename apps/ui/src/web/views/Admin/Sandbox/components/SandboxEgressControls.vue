<template>
  <div v-if="offlineOnly" class="offline-settings">
    <p class="section-note">{{ t('adminSandbox.offlineOnlyHint') }}</p>
    <ActionButton v-if="status.network_profile === 'egress'" variant="secondary" fit :disabled="egressSaving" @click="toggleEgress(false)">{{ t('adminSandbox.restoreOffline') }}</ActionButton>
  </div>
  <template v-else>
    <div class="config-row config-row-switch">
      <div class="config-row-copy"><span>{{ t('adminSandbox.egress') }}</span><small>{{ egressHint }}</small></div>
      <ToggleSwitch :model-value="status.network_profile === 'egress'" :disabled="!status.egress_available || egressSaving" :aria-label="t('adminSandbox.switchEgress')" @update:model-value="toggleEgress" />
    </div>
    <div class="egress-editor">
      <span class="egress-label">{{ t('adminSandbox.proxyAddress') }}</span>
      <div class="egress-input-row">
        <input v-model="proxyDraft" class="egress-input" type="url" inputmode="url" placeholder="http://egress-proxy:3128" autocomplete="off" :aria-label="t('adminSandbox.proxyAddress')" />
        <ActionButton variant="secondary" fit :disabled="egressSaving" @click="saveEgressProxy">{{ egressSaving ? t('adminSandbox.saving') : t('adminSandbox.saveProxy') }}</ActionButton>
        <ActionButton variant="secondary" fit :disabled="egressTesting || !status.egress_proxy_configured" @click="validateEgressProxy">{{ egressTesting ? t('adminSandbox.check') : t('adminSandbox.validate') }}</ActionButton>
      </div>
      <p class="egress-note">{{ t('adminSandbox.proxyHint') }}</p>
    </div>
    <p class="section-note">{{ t('adminSandbox.policyHint') }}</p>
  </template>
  <p v-if="egressMessage" class="action-message" :class="{ error: egressError }">{{ egressMessage }}</p>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { useConfigStore } from '@/stores/config'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { SandboxStatus } from '../sandbox-status'

const props = defineProps<{ status: SandboxStatus; offlineOnly: boolean; reloadStatus(): Promise<void> }>()
const { t } = useI18n()
const adminStore = useAdminStore()
const configStore = useConfigStore()
const egressSaving = ref(false)
const egressTesting = ref(false)
const proxyDraft = ref('')
watch(() => props.status.egress_proxy_url, (url) => { proxyDraft.value = url || '' }, { immediate: true })
const egressMessage = ref('')
const egressError = ref(false)
const egressHint = computed(() => {
  if (props.status.egress_config_error) return props.status.egress_config_error
  if (!props.status.egress_proxy_configured) return t('adminSandbox.proxyNotConfigured')
  if (!props.status.egress_network_ready) return t('adminSandbox.networkNotReady')
  return props.status.network_profile === 'egress' ? t('adminSandbox.egressEnabled') : t('adminSandbox.egressAvailable')
})

async function toggleEgress(enabled: boolean) {
  egressSaving.value = true
  egressMessage.value = ''
  egressError.value = false
  try {
    await configStore.saveConfig({ sandbox: { network_profile: enabled ? 'egress' : 'none' } })
    if (configStore.saveError) throw new Error(configStore.saveError)
    await props.reloadStatus()
  } catch (cause) {
    egressError.value = true
    egressMessage.value = cause instanceof Error ? cause.message : String(cause)
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
    await props.reloadStatus()
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
</script>

<style scoped>
.config-row, .offline-settings { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--panel-divider); }
.config-row-copy { min-width: 0; color: var(--content-tertiary); font-size: 12px; }
.config-row-copy small { display: block; margin-top: 4px; font-size: 11px; line-height: 1.4; }
.action-message { color: var(--status-success); font-size: 12px; }
.action-message.error { color: var(--status-danger); }
.offline-settings .section-note { margin: 0; min-width: 0; }
.section-note { margin: 10px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.6; }
.egress-editor { padding: 14px 0 4px; border-bottom: 1px solid var(--panel-divider); }
.egress-label { display: block; margin-bottom: 8px; color: var(--content-secondary); font-size: 12px; font-weight: 600; }
.egress-input-row { display: flex; align-items: center; gap: 8px; }
.egress-input { min-width: 0; flex: 1; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); background: var(--surface-glass); color: var(--content-primary); font-family: var(--font-mono); font-size: 12px; outline: none; }
.egress-input:focus { border-color: var(--input-border-focus); }
.egress-note { margin: 8px 0 0; color: var(--content-tertiary); font-size: 11px; line-height: 1.5; }
@media (max-width: 620px) { .egress-input-row { align-items: stretch; flex-wrap: wrap; } .egress-input { flex-basis: 100%; } }
</style>
