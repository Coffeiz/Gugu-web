<template>
  <section class="reconcile-card">
    <div class="reconcile-copy">
      <div class="reconcile-title">{{ t('adminQuota.fullReconcileTitle') }}</div>
      <p>{{ t('adminQuota.fullReconcileHint') }}</p>
      <div v-if="state.status !== 'idle'" class="reconcile-status" :class="state.status">
        <span>{{ statusLabel }}</span>
        <span v-if="state.status === 'running' || state.status === 'completed' || state.status === 'interrupted'">
          {{ t('adminQuota.fullReconcileProgress', { processed: state.processed || 0, total: state.total || 0 }) }}
        </span>
        <span v-if="state.status === 'completed'">
          {{ t('adminQuota.fullReconcileResult', { completed: state.completed || 0, failed: state.failed || 0 }) }}
        </span>
      </div>
      <div v-if="state.status === 'running' && state.total" class="progress-track" role="progressbar" :aria-valuenow="state.processed || 0" :aria-valuemax="state.total">
        <span :style="{ width: `${progressPercent}%` }" />
      </div>
      <p v-if="errorMessage" class="reconcile-error">{{ errorMessage }}</p>
    </div>
    <button class="btn-save" :disabled="active || starting" @click="start">
      {{ active ? t('adminQuota.fullReconcileRunning') : starting ? t('adminQuota.fullReconcileStarting') : t('adminQuota.fullReconcileAction') }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'

const { t } = useI18n()
const adminStore = useAdminStore()
const state = reactive<Record<string, any>>({ status: 'idle', total: 0, processed: 0, completed: 0, failed: 0 })
const starting = ref(false)
const errorMessage = ref('')
const active = computed(() => state.status === 'queued' || state.status === 'running')
const progressPercent = computed(() => state.total ? Math.min(100, Math.round((state.processed / state.total) * 100)) : 0)
const statusLabel = computed(() => {
  const keys: Record<string, string> = {
    queued: 'fullReconcileQueued', running: 'fullReconcileRunning', completed: 'fullReconcileDone',
    failed: 'fullReconcileFailed', interrupted: 'fullReconcileInterrupted', busy: 'fullReconcileBusy',
  }
  return keys[state.status] ? t(`adminQuota.${keys[state.status]}`) : ''
})

let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

function schedulePoll() {
  if (disposed || !active.value) return
  pollTimer = setTimeout(() => { void loadStatus() }, 2500)
}

async function loadStatus() {
  try {
    const response = await adminStore.authFetch('/api/v1/admin/storage-quota/reconcile')
    if (!response.ok) throw new Error()
    Object.assign(state, await response.json())
    errorMessage.value = ''
  } catch {
    errorMessage.value = t('adminQuota.fullReconcileRequestFailed')
  } finally {
    schedulePoll()
  }
}

async function start() {
  starting.value = true
  errorMessage.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/storage-quota/reconcile', { method: 'POST' })
    if (!response.ok) throw new Error()
    const result = await response.json()
    Object.assign(state, result.state || {})
    schedulePoll()
  } catch {
    errorMessage.value = t('adminQuota.fullReconcileRequestFailed')
  } finally {
    starting.value = false
  }
}

onMounted(() => { void loadStatus() })
onBeforeUnmount(() => { disposed = true; if (pollTimer) clearTimeout(pollTimer) })
</script>

<style scoped>
.reconcile-card {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 18px 20px; border-radius: 14px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
}
.reconcile-copy { min-width: 0; flex: 1; }
.reconcile-title { color: rgba(255,255,255,0.82); font-size: 13px; font-weight: 650; }
.reconcile-copy p { margin: 6px 0 0; color: rgba(255,255,255,0.38); font-size: 12px; line-height: 1.5; }
.reconcile-status { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: rgba(255,255,255,0.58); font-size: 12px; }
.reconcile-status.completed { color: #75c6a7; }
.reconcile-status.failed, .reconcile-status.interrupted { color: #e07878; }
.progress-track { height: 4px; margin-top: 8px; border-radius: 5px; overflow: hidden; background: rgba(255,255,255,0.08); }
.progress-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7b7fb2, #9590c4); transition: width .2s ease; }
.reconcile-error { color: #e07878 !important; }
.btn-save {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  min-height: 34px; padding: 7px 16px; border: 0; border-radius: 9px;
  background: var(--action-primary-bg); color: var(--content-on-accent);
  font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer;
  transition: background-color .15s, opacity .15s;
}
.btn-save:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
.btn-save:disabled { opacity: .5; cursor: default; }
@media (max-width: 680px) { .reconcile-card { align-items: stretch; flex-direction: column; gap: 14px; } .reconcile-card > button { align-self: flex-start; } }
</style>
