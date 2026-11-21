<template>
  <Teleport to="body">
    <div
      v-if="user"
      class="modal-mask"
      @mousedown.self="maskMousedownSelf = true"
      @mouseup.self="maskMousedownSelf && emit('cancel'); maskMousedownSelf = false"
    >
      <div class="modal-box">
        <p class="modal-title">{{ t('adminQuota.editQuota') }}</p>
        <p class="modal-subtitle">{{ user.display_name || user.username }}</p>

        <div class="quota-fields quota-fields--single" style="margin-top:18px">
          <div class="quota-field">
            <label class="qf-label">{{ t('adminQuota.token6h') }}
              <span class="qf-hint">{{ t('adminQuota.burstHint') }}</span>
            </label>
            <div class="qf-input-row">
              <input v-model.number="form.token6h" class="qf-input" type="number" min="0" :disabled="unlimited.token6h" :placeholder="placeholder('token6h')" />
              <span class="qf-unit">tokens</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="setMode('token6h', 'inherit')">{{ t('adminQuota.followGlobal') }}</button>
              <button class="preset-chip" @click="setMode('token6h', 'unlimited')">{{ t('adminQuota.unlimited') }}</button>
              <button class="preset-chip" @click="setValue('token6h', 50000)">{{ t('adminQuota.tokensWan', { count: 5 }) }}</button>
              <button class="preset-chip" @click="setValue('token6h', 100000)">{{ t('adminQuota.tokensWan', { count: 10 }) }}</button>
              <button class="preset-chip" @click="setValue('token6h', 300000)">{{ t('adminQuota.tokensWan', { count: 30 }) }}</button>
            </div>
          </div>

          <div class="quota-field">
            <label class="qf-label">{{ t('adminQuota.tokenWeek') }}
              <span class="qf-hint">{{ t('adminQuota.mondayReset') }}</span>
            </label>
            <div class="qf-input-row">
              <input v-model.number="form.tokenWeek" class="qf-input" type="number" min="0" :disabled="unlimited.tokenWeek" :placeholder="placeholder('tokenWeek')" />
              <span class="qf-unit">tokens</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="setMode('tokenWeek', 'inherit')">{{ t('adminQuota.followGlobal') }}</button>
              <button class="preset-chip" @click="setMode('tokenWeek', 'unlimited')">{{ t('adminQuota.unlimited') }}</button>
              <button class="preset-chip" @click="setValue('tokenWeek', 200000)">{{ t('adminQuota.tokensWan', { count: 20 }) }}</button>
              <button class="preset-chip" @click="setValue('tokenWeek', 500000)">{{ t('adminQuota.tokensWan', { count: 50 }) }}</button>
              <button class="preset-chip" @click="setValue('tokenWeek', 1000000)">{{ t('adminQuota.tokensWan', { count: 100 }) }}</button>
            </div>
          </div>

          <div class="quota-field">
            <label class="qf-label">{{ t('adminQuota.storage') }}</label>
            <div class="qf-input-row">
              <input v-model.number="form.storageGB" class="qf-input" type="number" min="0" :disabled="unlimited.storage" :placeholder="placeholder('storage')" />
              <span class="qf-unit">GB</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="setMode('storage', 'inherit')">{{ t('adminQuota.followGlobal') }}</button>
              <button class="preset-chip" @click="setMode('storage', 'unlimited')">{{ t('adminQuota.unlimited') }}</button>
              <button class="preset-chip" @click="setValue('storage', 5)">5 GB</button>
              <button class="preset-chip" @click="setValue('storage', 20)">20 GB</button>
              <button class="preset-chip" @click="setValue('storage', 50)">50 GB</button>
              <button class="preset-chip" @click="setValue('storage', 100)">100 GB</button>
            </div>
          </div>

          <div class="quota-field">
            <label class="qf-label">{{ t('adminQuota.searchDaily') }}
              <span class="qf-hint">{{ t('adminQuota.dayReset') }}</span>
            </label>
            <div class="qf-input-row">
              <input v-model.number="form.searchDaily" class="qf-input" type="number" min="0" :placeholder="t('adminQuota.followGlobal')" />
              <span class="qf-unit">{{ t('adminQuota.timesUnit') }}</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="form.searchDaily = null">{{ t('adminQuota.followGlobal') }}</button>
              <button class="preset-chip" @click="form.searchDaily = 10">{{ t('adminQuota.times', { count: 10 }) }}</button>
              <button class="preset-chip" @click="form.searchDaily = 30">{{ t('adminQuota.times', { count: 30 }) }}</button>
              <button class="preset-chip" @click="form.searchDaily = 100">{{ t('adminQuota.times', { count: 100 }) }}</button>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" @click="emit('cancel')">{{ t('adminQuota.cancel') }}</button>
          <button class="btn-confirm" :disabled="saving" @click="save">
            {{ saving ? t('adminQuota.saving') : t('adminQuota.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

type QuotaModeKey = 'token6h' | 'tokenWeek' | 'storage'
type QuotaForm = {
  token6h: number | null
  tokenWeek: number | null
  storageGB: number | null
  searchDaily: number | null
}
type QuotaPayload = {
  token_limit_6h: number | null
  token_limit_weekly: number | null
  storage_limit_bytes: number | null
  search_limit_daily: number | null
}

const props = defineProps<{
  user: Record<string, any> | null
  saving: boolean
}>()
const emit = defineEmits<{
  cancel: []
  save: [payload: QuotaPayload]
}>()
const { t } = useI18n()
const maskMousedownSelf = ref(false)
const form = reactive<QuotaForm>({ token6h: null, tokenWeek: null, storageGB: null, searchDaily: null })
const unlimited = reactive({ token6h: false, tokenWeek: false, storage: false })

watch(() => props.user, (user) => {
  form.token6h = user?.token_limit_6h === -1 ? null : user?.token_limit_6h ?? null
  form.tokenWeek = user?.token_limit_weekly === -1 ? null : user?.token_limit_weekly ?? null
  form.storageGB = user?.storage_limit_bytes != null && user.storage_limit_bytes !== -1
    ? +(user.storage_limit_bytes / 1073741824).toFixed(2)
    : null
  form.searchDaily = user?.search_limit_daily ?? null
  unlimited.token6h = user?.token_limit_6h === -1
  unlimited.tokenWeek = user?.token_limit_weekly === -1
  unlimited.storage = user?.storage_limit_bytes === -1
}, { immediate: true })

function setMode(key: QuotaModeKey, mode: 'inherit' | 'unlimited') {
  unlimited[key] = mode === 'unlimited'
  if (key === 'token6h') form.token6h = null
  else if (key === 'tokenWeek') form.tokenWeek = null
  else form.storageGB = null
}

function setValue(key: QuotaModeKey, value: number) {
  unlimited[key] = false
  if (key === 'token6h') form.token6h = value
  else if (key === 'tokenWeek') form.tokenWeek = value
  else form.storageGB = value
}

function placeholder(key: QuotaModeKey) {
  return t(unlimited[key] ? 'adminQuota.unlimited' : 'adminQuota.followGlobal')
}

function save() {
  emit('save', {
    token_limit_6h: unlimited.token6h ? -1 : form.token6h != null ? Number(form.token6h) : null,
    token_limit_weekly: unlimited.tokenWeek ? -1 : form.tokenWeek != null ? Number(form.tokenWeek) : null,
    storage_limit_bytes: unlimited.storage
      ? -1
      : form.storageGB != null ? Math.round(Number(form.storageGB) * 1073741824) : null,
    search_limit_daily: form.searchDaily != null ? Number(form.searchDaily) : null,
  })
}
</script>

<style scoped>
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 9100;
}
.modal-box {
  background: rgba(18,20,36,0.96); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 16px; padding: 28px 28px 24px; width: 420px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
}
.modal-title { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.92); margin-bottom: 6px; }
.modal-subtitle { font-size: 13px; color: rgba(255,255,255,0.35); }
.quota-fields { display: grid; }
.quota-fields--single { grid-template-columns: 1fr; gap: 16px; }
.quota-field { display: flex; flex-direction: column; gap: 8px; }
.qf-label {
  display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600;
  color: rgba(255,255,255,0.4); letter-spacing: 0.04em;
}
.qf-hint { font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.2); letter-spacing: 0; }
.qf-input-row { display: flex; align-items: center; gap: 8px; }
.qf-input { flex: 1; height: 34px; padding: 0 12px; border-radius: 9px; font-size: 13px; outline: none; }
.qf-input:disabled { opacity: 0.55; }
.qf-unit { font-size: 12px; color: rgba(255,255,255,0.3); white-space: nowrap; }
.qf-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.preset-chip {
  padding: 3px 10px; border-radius: 7px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.4); transition: all 0.12s;
}
.preset-chip:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.7); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.btn-cancel, .btn-confirm {
  padding: 7px 18px; border-radius: 9px; font-size: 13px; cursor: pointer;
}
.btn-cancel { border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.55); }
.btn-confirm { border: none; background: var(--action-primary-bg); color: var(--content-on-accent); font-weight: 600; box-shadow: none; }
.btn-confirm:disabled { opacity: 0.5; cursor: default; }
</style>
