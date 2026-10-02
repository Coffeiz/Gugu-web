<template>
  <section class="config-card outbound-card">
    <div class="card-head">
      <div class="card-title-block">
        <h3>{{ t('adminConfig.egressTitle') }}</h3>
        <p>{{ t('adminConfig.egressDescription') }}</p>
      </div>
    </div>

    <label class="enabled-row">
      <input v-model="draft.enabled" type="checkbox" />
      <span>{{ t('adminConfig.egressEnabled') }}</span>
    </label>
    <p class="scope-note">{{ t('adminConfig.egressScope') }}</p>

    <div class="field-grid">
      <div class="field span2">
        <label for="safe-egress-proxy-url">{{ t('adminConfig.proxyUrl') }}</label>
        <input id="safe-egress-proxy-url" v-model.trim="draft.proxy_url" type="url" inputmode="url" autocomplete="url" placeholder="http://proxy.example:7890" />
      </div>
      <div class="field">
        <label for="safe-egress-proxy-username">{{ t('adminConfig.proxyUsername') }}</label>
        <input id="safe-egress-proxy-username" v-model="draft.proxy_username" autocomplete="off" />
      </div>
      <div class="field">
        <label for="safe-egress-proxy-password">{{ t('adminConfig.proxyPassword') }}</label>
        <input id="safe-egress-proxy-password" v-model="draft.proxy_password" type="password" autocomplete="new-password" :placeholder="state.has_auth ? t('adminConfig.authConfigured') : ''" />
      </div>
    </div>

    <div class="actions">
      <button v-if="state.has_auth" class="clear-auth" type="button" :disabled="busy" @click="draft.clear_credentials = !draft.clear_credentials">
        {{ draft.clear_credentials ? t('adminConfig.authWillClear') : t('adminConfig.clearAuth') }}
      </button>
      <span v-if="message" class="result" :class="{ error: !resultOk }" role="status">{{ message }}</span>
      <button type="button" class="button secondary" :disabled="busy" @click="testProxy">
        {{ testing ? t('adminConfig.testingProxy') : t('adminConfig.testProxy') }}
      </button>
      <button type="button" class="button primary" :disabled="busy" @click="saveProxy">
        {{ saving ? t('adminConfig.savingProxy') : t('adminConfig.saveProxy') }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
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
.outbound-card .card-head { margin: 0; }
.enabled-row { display: flex; align-items: center; gap: 9px; color: var(--text-primary); font-size: 13px; cursor: pointer; }
.enabled-row input { accent-color: var(--action-primary-bg); }
.scope-note { margin: -8px 0 0 24px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field > label { color: var(--text-muted); font-size: 11px; font-weight: 600; }
.field input { width: 100%; min-width: 0; padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 9px; background: var(--input-bg); color: var(--text-primary); font: 13px var(--font-sans); outline: none; transition: border-color .18s ease, box-shadow .18s ease; }
.field input:hover { border-color: var(--input-border-hover, var(--input-border)); }
.field input:focus { border-color: var(--input-border-focus, var(--action-primary-bg)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--action-primary-bg) 16%, transparent); }
.span2 { grid-column: span 2; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.result { margin-right: auto; color: var(--status-success, #5ab899); font-size: 12px; line-height: 1.45; }
.result.error { color: var(--status-danger, #e07878); }
.button, .clear-auth { border: 1px solid var(--panel-divider); border-radius: 9px; padding: 7px 12px; color: var(--text-secondary); background: var(--panel-bg); font: inherit; font-size: 12px; cursor: pointer; transition: border-color .18s ease, color .18s ease, opacity .18s ease; }
.button:hover:not(:disabled), .clear-auth:hover:not(:disabled) { border-color: var(--input-border-hover, var(--input-border)); color: var(--text-primary); }
.button.primary { background: var(--action-primary-bg); border-color: transparent; color: #fff; }
.button:disabled, .clear-auth:disabled { opacity: .55; cursor: default; }
@media (max-width: 640px) { .field-grid { grid-template-columns: 1fr; } .span2 { grid-column: auto; } .actions { justify-content: flex-start; } .result { flex-basis: 100%; } }
</style>
