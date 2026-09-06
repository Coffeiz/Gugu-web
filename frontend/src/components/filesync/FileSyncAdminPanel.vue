<template>
  <section class="fs-card">
    <div class="fs-head">
      <div>
        <h3 class="fs-title">{{ t('filesyncAdmin.title') }}</h3>
        <p class="fs-sub">{{ t('filesyncAdmin.description') }}</p>
      </div>
      <button class="fs-btn" :disabled="loading" @click="load">
        {{ loading ? t('filesyncAdmin.loading') : t('filesyncAdmin.refresh') }}
      </button>
    </div>

    <div v-if="error" class="fs-message is-error">{{ error }}</div>
    <div v-if="status" class="fs-body">
      <div class="fs-banner" :class="status.supported ? 'is-ok' : 'is-muted'">
        <span class="fs-dot" aria-hidden="true" />
        <span>{{ status.supported ? t('filesyncAdmin.localReady') : t('filesyncAdmin.independentMode') }}</span>
        <span class="fs-banner-meta">{{ t('filesyncAdmin.backend') }}：{{ status.storageBackend }} · {{ t('filesyncAdmin.feature') }}：{{ status.featureEnabled ? t('filesyncAdmin.enabled') : t('filesyncAdmin.disabled') }}</span>
      </div>

      <div class="fs-metrics">
        <div class="fs-metric"><span>{{ t('filesyncAdmin.bindings') }}</span><b>{{ status.totals.bindings }}</b></div>
        <div class="fs-metric"><span>{{ t('filesyncAdmin.pending') }}</span><b>{{ status.totals.pendingJournals }}</b></div>
        <div class="fs-metric"><span>{{ t('filesyncAdmin.conflicts') }}</span><b :class="{ warn: status.totals.pendingConflicts }">{{ status.totals.pendingConflicts }}</b></div>
        <div class="fs-metric"><span>{{ t('filesyncAdmin.outbox') }}</span><b :class="{ warn: status.totals.pendingOutbox }">{{ status.totals.pendingOutbox }}</b></div>
      </div>

      <div v-if="status.ignoredBindingCount" class="fs-note">{{ t('filesyncAdmin.ignoredBindings', { count: status.ignoredBindingCount }) }}</div>

      <div v-if="status.bindings.length" class="fs-block">
        <div class="fs-block-title">{{ t('filesyncAdmin.bindingList') }}</div>
        <div v-for="binding in status.bindings" :key="binding.id" class="fs-row">
          <div class="fs-row-main">
            <strong>#{{ binding.id }} · {{ binding.mode }}</strong>
            <span>{{ binding.rootPath }} · {{ binding.userId }}</span>
            <small>{{ t('filesyncAdmin.revision') }} {{ binding.revision }} · {{ t('filesyncAdmin.conflictCount') }} {{ binding.pendingConflicts }}</small>
          </div>
          <div class="fs-actions">
            <button class="fs-action" :disabled="actionKey === `dry-${binding.id}`" @click="dryRun(binding.id)">{{ actionKey === `dry-${binding.id}` ? t('filesyncAdmin.working') : t('filesyncAdmin.dryRun') }}</button>
            <button class="fs-action is-primary" :disabled="actionKey === `sync-${binding.id}`" @click="reconcile(binding.id)">{{ actionKey === `sync-${binding.id}` ? t('filesyncAdmin.working') : t('filesyncAdmin.reconcile') }}</button>
          </div>
        </div>
      </div>

      <div v-if="dryResult" class="fs-result">
        {{ t('filesyncAdmin.dryRunResult', { scanned: dryResult.summary.scanned, created: dryResult.summary.created, updated: dryResult.summary.updated, rejected: dryResult.summary.rejected, conflicts: dryResult.summary.conflicts }) }}
      </div>

      <div v-if="status.conflicts.length" class="fs-block">
        <div class="fs-block-title">{{ t('filesyncAdmin.conflictList') }}</div>
        <div v-for="conflict in status.conflicts" :key="conflict.id" class="fs-row">
          <div class="fs-row-main">
            <strong>#{{ conflict.id }} · {{ conflict.relativePath }}</strong>
            <span>{{ t('filesyncAdmin.bindingRef') }} #{{ conflict.bindingId }} · {{ conflict.userId }}</span>
          </div>
          <div class="fs-actions">
            <button v-for="resolution in resolutions" :key="resolution.value" class="fs-action" :class="{ 'is-danger': resolution.value === 'keep_remote' }" :disabled="actionKey === `conflict-${conflict.id}`" @click="resolve(conflict.id, resolution.value)">{{ t(resolution.label) }}</button>
          </div>
        </div>
      </div>

      <div v-if="status.failures.length" class="fs-block">
        <div class="fs-block-title">{{ t('filesyncAdmin.failures') }}</div>
        <div v-for="failure in status.failures" :key="`${failure.kind}-${failure.id}`" class="fs-failure">
          {{ failure.kind }} #{{ failure.id }} · {{ failure.status }} · {{ failure.errorCode }} · {{ failure.updatedAt || '—' }}
        </div>
      </div>

      <p class="fs-footnote">{{ t('filesyncAdmin.recoveryHint') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { filesyncAdminApi, type FileSyncAdminStatus, type FileSyncActionResult } from '@/api/filesync'

const { t } = useI18n()
const adminStore = useAdminStore()
const status = ref<FileSyncAdminStatus | null>(null)
const dryResult = ref<FileSyncActionResult | null>(null)
const loading = ref(false)
const error = ref('')
const actionKey = ref('')
const resolutions = [
  { value: 'keep_local' as const, label: 'filesyncAdmin.keepLocal' },
  { value: 'keep_remote' as const, label: 'filesyncAdmin.keepRemote' },
  { value: 'keep_both' as const, label: 'filesyncAdmin.keepBoth' },
  { value: 'cancel' as const, label: 'filesyncAdmin.cancelConflict' },
]

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { status.value = await filesyncAdminApi.status(adminStore.authFetch) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { loading.value = false }
}

async function dryRun(bindingId: number) {
  actionKey.value = `dry-${bindingId}`
  error.value = ''
  try { dryResult.value = await filesyncAdminApi.dryRun(adminStore.authFetch, bindingId) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { actionKey.value = '' }
}

async function reconcile(bindingId: number) {
  if (!await confirmDialog({ title: t('filesyncAdmin.reconcileTitle'), message: t('filesyncAdmin.reconcileConfirm'), tone: 'warning', confirmText: t('filesyncAdmin.reconcile') })) return
  actionKey.value = `sync-${bindingId}`
  error.value = ''
  try { await filesyncAdminApi.reconcile(adminStore.authFetch, bindingId); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { actionKey.value = '' }
}

async function resolve(conflictId: number, resolution: typeof resolutions[number]['value']) {
  if (resolution !== 'cancel' && !await confirmDialog({ title: t('filesyncAdmin.resolveTitle'), message: t('filesyncAdmin.resolveConfirm'), tone: resolution === 'keep_remote' ? 'danger' : 'warning', confirmText: t('filesyncAdmin.confirmResolve') })) return
  actionKey.value = `conflict-${conflictId}`
  error.value = ''
  try { await filesyncAdminApi.resolveConflict(adminStore.authFetch, conflictId, resolution); await load() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { actionKey.value = '' }
}

onMounted(load)
</script>

<style scoped>
.fs-card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 20px 22px; margin-bottom: 20px; color: var(--content-primary); }
.fs-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
.fs-title { margin:0; font-size:15px; font-weight:700; }
.fs-sub { margin:4px 0 0; font-size:12px; color:var(--content-secondary); max-width:720px; }
.fs-btn,.fs-action { border:1px solid var(--action-outline); background:var(--control-bg); color:var(--content-primary); border-radius:8px; padding:6px 11px; font-size:12px; cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.fs-btn:hover:not(:disabled),.fs-action:hover:not(:disabled) { background:var(--control-bg-hover); }
.fs-action.is-primary { background:var(--action-primary-bg); color:var(--content-on-accent); border-color:transparent; }
.fs-action.is-danger { color:var(--status-danger); }
.fs-btn:disabled,.fs-action:disabled { opacity:.5; cursor:default; }
.fs-message { padding:8px 12px; border-radius:8px; font-size:12px; margin-bottom:10px; }
.fs-message.is-error { color:var(--status-danger); background:color-mix(in srgb,var(--status-danger) 10%,transparent); }
.fs-banner { display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:9px; font-size:12px; }
.fs-banner.is-ok { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,transparent); }
.fs-banner.is-muted { color:var(--content-secondary); background:var(--control-bg); }
.fs-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:0 0 auto; }
.fs-banner-meta { margin-left:auto; color:var(--content-secondary); }
.fs-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:12px 0; }
.fs-metric { padding:10px 12px; border:1px solid var(--border-subtle); border-radius:9px; background:var(--surface-elevated); }
.fs-metric span { display:block; color:var(--content-secondary); font-size:11px; margin-bottom:4px; }
.fs-metric b { font-size:18px; }
.fs-metric b.warn { color:var(--status-warning); }
.fs-note,.fs-footnote { color:var(--content-secondary); font-size:11px; line-height:1.6; }
.fs-block { margin-top:14px; }
.fs-block-title { font-size:12px; font-weight:700; margin-bottom:7px; }
.fs-row { display:flex; align-items:center; gap:12px; padding:9px 0; border-top:1px solid var(--border-subtle); }
.fs-row-main { min-width:0; flex:1; display:flex; flex-direction:column; gap:3px; font-size:12px; }
.fs-row-main strong { overflow-wrap:anywhere; }
.fs-row-main span,.fs-row-main small { color:var(--content-secondary); overflow-wrap:anywhere; }
.fs-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; flex:0 0 auto; }
.fs-result { margin-top:12px; padding:9px 11px; border-radius:9px; color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,transparent); font-size:12px; }
.fs-failure { border-top:1px solid var(--border-subtle); padding:7px 0; color:var(--status-danger); font-size:11px; overflow-wrap:anywhere; }
@media (max-width:720px) { .fs-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .fs-row { align-items:flex-start; flex-direction:column; } .fs-actions { justify-content:flex-start; } .fs-banner { align-items:flex-start; flex-wrap:wrap; } .fs-banner-meta { margin-left:0; flex-basis:100%; } }
</style>
