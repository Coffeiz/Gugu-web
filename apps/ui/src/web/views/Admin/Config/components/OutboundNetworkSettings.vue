<template>
  <section class="config-card outbound-card">
    <div class="card-head">
      <div class="card-icon" style="--ic: color-mix(in srgb, var(--status-info) 14%, transparent); --stroke: var(--status-info)">
        <Icon name="admin.shield" size="md" />
      </div>
      <div class="card-title-block">
        <h3>{{ t('adminConfig.egressTitle') }}</h3>
        <p>{{ t('adminConfig.egressDescription') }}</p>
      </div>
    </div>

    <p class="scope-note">{{ t('adminConfig.egressScope') }}</p>

    <div class="field-grid">
      <div class="field span2">
        <span id="safe-egress-proxy-url-label" class="field-label">{{ t('adminConfig.proxyUrl') }}</span>
        <input id="safe-egress-proxy-url" v-model.trim="draft.proxy_url" class="form-input" aria-labelledby="safe-egress-proxy-url-label" type="url" inputmode="url" autocomplete="url" placeholder="http://proxy.example:7890" />
      </div>
      <div class="field">
        <span id="safe-egress-proxy-username-label" class="field-label">{{ t('adminConfig.proxyUsername') }}</span>
        <input id="safe-egress-proxy-username" v-model="draft.proxy_username" class="form-input" aria-labelledby="safe-egress-proxy-username-label" autocomplete="off" />
      </div>
      <div class="field">
        <span id="safe-egress-proxy-password-label" class="field-label">{{ t('adminConfig.proxyPassword') }}</span>
        <input id="safe-egress-proxy-password" v-model="draft.proxy_password" class="form-input" aria-labelledby="safe-egress-proxy-password-label" type="password" autocomplete="new-password" :placeholder="state.has_auth ? t('adminConfig.authConfigured') : ''" />
      </div>
    </div>

    <div class="actions">
      <ActionButton v-if="state.has_auth" :variant="draft.clear_credentials ? 'danger' : 'secondary'" fit :disabled="busy" @click="draft.clear_credentials = !draft.clear_credentials">
        {{ draft.clear_credentials ? t('adminConfig.authWillClear') : t('adminConfig.clearAuth') }}
      </ActionButton>
      <span v-if="message" class="result" :class="{ error: !resultOk }" role="status">{{ message }}</span>
      <div class="proxy-toggle">
        <span>{{ t('adminConfig.egressEnabled') }}</span>
        <ToggleSwitch v-model="draft.enabled" size="sm" :disabled="busy" :aria-label="t('adminConfig.egressEnabled')" />
      </div>
      <ActionButton variant="secondary" fit :disabled="busy" @click="testProxy">
        {{ testing ? t('adminConfig.testingProxy') : t('adminConfig.testProxy') }}
      </ActionButton>
      <ActionButton variant="primary" fit :disabled="busy" @click="saveProxy">
        {{ saving ? t('adminConfig.savingProxy') : t('adminConfig.saveProxy') }}
      </ActionButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useAdminStore } from '@/stores/admin'

const { t } = useI18n()
const admin = useAdminStore()
const state = reactive({ has_auth: false })
const draft = reactive({
  enabled: false,
  proxy_url: '',
  proxy_username: '',
  proxy_password: '',
  clear_credentials: false,
})
const busy = ref(false)
const testing = ref(false)
const saving = ref(false)
const message = ref('')
const resultOk = ref(true)

function payload() {
  const value: Record<string, unknown> = {
    enabled: draft.enabled,
    proxy_url: draft.proxy_url,
    clear_credentials: draft.clear_credentials,
  }
  if (draft.proxy_username) value.proxy_username = draft.proxy_username
  if (draft.proxy_password) value.proxy_password = draft.proxy_password
  return value
}

async function readError(response: Response) {
  const data = await response.json().catch(() => ({}))
  return data.detail || t('adminConfig.egressRequestFailed', { status: response.status })
}

async function load() {
  try {
    const response = await admin.authFetch('/api/v1/admin/safe-egress')
    if (!response.ok) throw new Error(await readError(response))
    const data = await response.json()
    draft.enabled = !!data.enabled
    draft.proxy_url = data.proxy_url || ''
    state.has_auth = !!data.has_auth
  } catch (error) {
    message.value = error instanceof Error ? error.message : t('adminConfig.egressLoadFailed')
    resultOk.value = false
  }
}

async function saveProxy() {
  busy.value = true
  saving.value = true
  message.value = ''
  try {
    const response = await admin.authFetch('/api/v1/admin/safe-egress', {
      method: 'PATCH', body: JSON.stringify(payload()),
    })
    if (!response.ok) throw new Error(await readError(response))
    const data = await response.json()
    state.has_auth = !!data.has_auth
    draft.proxy_password = ''
    draft.proxy_username = ''
    draft.clear_credentials = false
    message.value = t('adminConfig.egressSaved')
    resultOk.value = true
  } catch (error) {
    message.value = error instanceof Error ? error.message : t('adminConfig.egressSaveFailed')
    resultOk.value = false
  } finally {
    saving.value = false
    busy.value = false
  }
}

async function testProxy() {
  busy.value = true
  testing.value = true
  message.value = ''
  try {
    const response = await admin.authFetch('/api/v1/admin/safe-egress/test', {
      method: 'POST', body: JSON.stringify(payload()),
    })
    if (!response.ok) throw new Error(await readError(response))
    const data = await response.json()
    message.value = `${data.message} · ${data.elapsed_ms} ms`
    resultOk.value = !!data.ok
  } catch (error) {
    message.value = error instanceof Error ? error.message : t('adminConfig.egressTestFailed')
    resultOk.value = false
  } finally {
    testing.value = false
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.outbound-card { display: flex; flex-direction: column; gap: 14px; }
.outbound-card .card-head { display: flex; align-items: center; gap: 13px; margin: 0; }
.card-icon { width: 38px; height: 38px; border-radius: 11px; background: var(--ic); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.card-icon :deep(svg) { width: 18px; height: 18px; color: var(--stroke); }
.card-title-block { min-width: 0; flex: 1; }
.card-title-block h3 { margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; line-height: 1.4; }
.card-title-block p { margin: 2px 0 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }
.scope-note { margin: 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field-label { color: var(--content-secondary); font-size: 12px; line-height: 1.4; }
.field .form-input { width: 100%; min-width: 0; }
.span2 { grid-column: span 2; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.proxy-toggle { display: inline-flex; align-items: center; gap: 8px; color: var(--content-secondary); font-size: 12px; white-space: nowrap; }
.result { margin-right: auto; color: var(--status-success); font-size: 12px; line-height: 1.45; }
.result.error { color: var(--status-danger); }
@media (max-width: 640px) { .field-grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } .actions { justify-content: flex-start; } .result { flex-basis: 100%; } }
</style>
