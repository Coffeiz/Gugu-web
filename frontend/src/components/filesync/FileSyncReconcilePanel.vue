<template>
  <ActionButton variant="secondary" fit @click="open">
    <Icon name="action.refresh" size="sm" />{{ t('filesyncUser.open') }}
  </ActionButton>
  <BaseModal :show="show" width="760px" height="min(760px, calc(100vh - 48px))" background="var(--panel-bg)" @close="show = false">
      <section class="fs-user-panel">
        <header class="fs-user-head">
          <div>
            <h2>{{ t('filesyncUser.title') }}</h2>
            <p>{{ t('filesyncUser.description') }}</p>
          </div>
          <ActionButton variant="secondary" fit :disabled="loading" @click="load">
            <Icon name="action.refresh" size="sm" />{{ t('filesyncUser.refresh') }}
          </ActionButton>
        </header>

        <p v-if="error" class="fs-user-message is-error" role="alert">{{ error }}</p>
        <p v-if="notice" class="fs-user-message">{{ notice }}</p>
        <div class="fs-user-content">
          <section class="fs-user-section">
            <h3>{{ t('filesyncUser.bindings') }}</h3>
            <div v-if="loading && !bindings.length" class="fs-user-empty">{{ t('filesyncUser.loading') }}</div>
            <div v-else-if="!bindings.length" class="fs-user-empty">
              <p>{{ t('filesyncUser.noBinding') }}</p>
              <ActionButton :disabled="actionKey === 'first-preview'" @click="previewDefault">
                {{ actionKey === 'first-preview' ? t('filesyncUser.working') : t('filesyncUser.previewDefault') }}
              </ActionButton>
            </div>
            <article v-for="binding in bindings" :key="binding.id" class="fs-user-binding">
              <div class="fs-user-binding-copy">
                <strong>{{ t('filesyncUser.binding', { id: binding.id }) }} · {{ binding.mode }}</strong>
                <span>{{ binding.rootPath }}</span>
                <small :class="{ 'is-warning': binding.needsReconcile || !['ready', 'inactive', 'unknown'].includes(binding.watcherStatus) }">
                  {{ t('filesyncUser.watcher', { status: binding.watcherStatus }) }}
                  · {{ t(binding.needsReconcile ? 'filesyncUser.needsReconcile' : 'filesyncUser.noKnownGap') }}
                  <template v-if="binding.healthErrorCode"> · {{ binding.healthErrorCode }}</template>
                </small>
              </div>
              <div class="fs-user-actions">
                <ActionButton variant="secondary" fit :disabled="Boolean(actionKey)" @click="preview(binding)">
                  {{ actionKey === `preview-${binding.id}` ? t('filesyncUser.working') : t('filesyncUser.preview') }}
                </ActionButton>
                <ActionButton fit :disabled="Boolean(actionKey)" @click="reconcile(binding)">
                  {{ actionKey === `repair-${binding.id}` ? t('filesyncUser.working') : t(binding.lastReconciledAt ? 'filesyncUser.reconcile' : 'filesyncUser.initialize') }}
                </ActionButton>
              </div>
              <label v-if="binding.lastReconciledAt" class="fs-user-delete-option">
                <input v-model="allowDelete" type="checkbox" />
                <span>{{ t('filesyncUser.allowDelete') }}</span>
              </label>
            </article>
          </section>

          <section class="fs-user-section">
            <h3>{{ t('filesyncUser.recentRuns') }}</h3>
            <div v-if="!runs.length" class="fs-user-empty">{{ t('filesyncUser.noRuns') }}</div>
            <article v-for="run in runs" :key="run.id" class="fs-user-run">
              <div class="fs-user-run-head">
                <strong>{{ t(`filesyncUser.action.${run.action}`) }} · {{ t(`filesyncUser.status.${run.status}`) }}</strong>
                <ActionButton v-if="['queued', 'running', 'cancelling'].includes(run.status)" variant="secondary" fit :disabled="actionKey === `cancel-${run.id}`" @click="cancelRun(run)">
                  {{ t('filesyncUser.cancelRun') }}
                </ActionButton>
              </div>
              <span>{{ t('filesyncUser.stage', { stage: t(`filesyncUser.stageName.${run.stage || 'unknown'}`) }) }} · {{ t('filesyncUser.scanned', { count: run.scannedCount }) }}</span>
              <span>{{ resultSummary(run) }}</span>
              <strong v-if="run.errorCode" class="is-error">{{ t('filesyncUser.error', { code: run.errorCode }) }}</strong>
              <small v-if="hasPartialResult(run)" class="is-warning">{{ t('filesyncUser.partialResult') }}</small>
            </article>
          </section>
        </div>
      </section>
  </BaseModal>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { filesyncUserApi, type FileSyncRunStatus, type FileSyncUserBinding } from '@/api/filesync'
import { useLiveStore } from '@/stores/live'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import Icon from '@/components/common/icons/Icon.vue'

const { t } = useI18n()
const liveStore = useLiveStore()
const show = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const actionKey = ref('')
const bindings = ref<FileSyncUserBinding[]>([])
const runs = ref<FileSyncRunStatus[]>([])
const allowDelete = ref(false)

let loadPromise: Promise<void> | null = null
let reloadRequested = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null

async function load() {
  if (!show.value) return
  if (loadPromise) {
    reloadRequested = true
    return loadPromise
  }
  loadPromise = (async () => {
    loading.value = true
    error.value = ''
    try {
      do {
        reloadRequested = false
        const [nextBindings, nextRuns] = await Promise.all([
          filesyncUserApi.bindings(),
          filesyncUserApi.runs(),
        ])
        bindings.value = nextBindings
        runs.value = nextRuns
      } while (reloadRequested && show.value)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
      loadPromise = null
    }
  })()
  return loadPromise
}

function scheduleRefresh() {
  if (!show.value) return
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void load()
  }, 120)
}

function open() {
  show.value = true
  notice.value = ''
  void load()
}

async function previewDefault() {
  actionKey.value = 'first-preview'
  error.value = ''
  try {
    const run = await filesyncUserApi.previewDefault()
    notice.value = t('filesyncUser.taskQueued')
    await load()
    if (!runs.value.some(item => item.id === run.id)) runs.value.unshift(run)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    actionKey.value = ''
  }
}

async function preview(binding: FileSyncUserBinding) {
  actionKey.value = `preview-${binding.id}`
  error.value = ''
  try {
    const run = await filesyncUserApi.preview(binding)
    notice.value = t('filesyncUser.taskQueued')
    await load()
    if (!runs.value.some(item => item.id === run.id)) runs.value.unshift(run)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    actionKey.value = ''
  }
}

async function reconcile(binding: FileSyncUserBinding) {
  const initialize = !binding.lastReconciledAt
  const confirmed = await confirmDialog({
    title: t(initialize ? 'filesyncUser.initializeTitle' : 'filesyncUser.reconcileTitle'),
    message: t(allowDelete.value && !initialize ? 'filesyncUser.reconcileDeleteConfirm' : initialize ? 'filesyncUser.initializeConfirm' : 'filesyncUser.reconcileConfirm'),
    tone: allowDelete.value && !initialize ? 'danger' : 'warning',
    confirmText: t(initialize ? 'filesyncUser.initialize' : 'filesyncUser.reconcile'),
  })
  if (!confirmed) return
  actionKey.value = `repair-${binding.id}`
  error.value = ''
  try {
    const run = initialize
      ? await filesyncUserApi.initialize(binding)
      : await filesyncUserApi.reconcile(binding.id, allowDelete.value)
    notice.value = t('filesyncUser.taskQueued')
    await load()
    if (!runs.value.some(item => item.id === run.id)) runs.value.unshift(run)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    actionKey.value = ''
  }
}

async function cancelRun(run: FileSyncRunStatus) {
  if (!await confirmDialog({
    title: t('filesyncUser.cancelTitle'),
    message: t('filesyncUser.cancelConfirm'),
    tone: 'warning',
    confirmText: t('filesyncUser.cancelRun'),
  })) return
  actionKey.value = `cancel-${run.id}`
  error.value = ''
  try {
    await filesyncUserApi.cancelRun(run.id)
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    actionKey.value = ''
  }
}

function resultSummary(run: FileSyncRunStatus) {
  const values = run.resultCounts
  return t('filesyncUser.results', {
    created: values.created ?? 0,
    updated: values.updated ?? 0,
    moved: values.moved ?? 0,
    deleted: values.deleted ?? 0,
    skipped: values.skipped ?? 0,
    conflicts: values.conflicts ?? 0,
    failed: values.failed ?? 0,
  })
}

function hasPartialResult(run: FileSyncRunStatus) {
  return ['failed', 'cancelled'].includes(run.status)
    && ['created', 'updated', 'moved', 'deleted'].some(key => (run.resultCounts[key] ?? 0) > 0)
}

watch(() => liveStore.fileSyncEvent, event => {
  if (event) scheduleRefresh()
})
watch(() => liveStore.connected, connected => {
  // 初次连通和每次重连都补读权威快照，覆盖连接建立前后的通知竞态。
  if (connected) scheduleRefresh()
})

onBeforeUnmount(() => {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
})
</script>

<style scoped>
.fs-user-panel { display:flex; flex-direction:column; min-height:0; height:100%; color:var(--content-primary); font-family:var(--font-sans); }
.fs-user-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:20px 22px 12px; border-bottom:1px solid var(--border-subtle); }
.fs-user-head h2 { margin:0; font-size:var(--font-size-lg); }
.fs-user-head p { margin:5px 0 0; color:var(--content-secondary); font-size:var(--font-size-sm); }
.fs-user-content { min-height:0; overflow:auto; padding:16px 22px 22px; }
.fs-user-section + .fs-user-section { margin-top:20px; }
.fs-user-section h3 { margin:0 0 8px; font-size:var(--font-size-sm); }
.fs-user-empty { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px; color:var(--content-secondary); background:var(--surface-elevated); border-radius:10px; font-size:var(--font-size-sm); }
.fs-user-binding,.fs-user-run { display:flex; flex-direction:column; gap:8px; padding:12px 0; border-top:1px solid var(--border-subtle); }
.fs-user-binding-copy { min-width:0; display:flex; flex-direction:column; gap:3px; font-size:var(--font-size-sm); }
.fs-user-binding-copy strong,.fs-user-binding-copy span,.fs-user-binding-copy small { min-width:0; overflow-wrap:anywhere; }
.fs-user-binding-copy span,.fs-user-binding-copy small,.fs-user-run span,.fs-user-run small { color:var(--content-secondary); font-size:var(--font-size-xs); }
.fs-user-actions { display:flex; flex-wrap:wrap; gap:7px; }
.fs-user-delete-option { display:flex; align-items:flex-start; gap:7px; color:var(--status-warning); font-size:var(--font-size-xs); }
.fs-user-delete-option input { margin-top:2px; }
.fs-user-run-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.fs-user-run-head strong { min-width:0; overflow-wrap:anywhere; font-size:var(--font-size-sm); }
.fs-user-message { margin:12px 22px 0; padding:9px 11px; border-radius:9px; background:var(--surface-elevated); color:var(--content-secondary); font-size:var(--font-size-sm); }
.is-error { color:var(--status-danger) !important; }
.is-warning { color:var(--status-warning) !important; }
@media (max-width: 640px) { .fs-user-head { padding-inline:14px; } .fs-user-content { padding-inline:14px; } }
</style>
