<template>
  <section class="fs-card">
    <div class="fs-head">
      <div>
        <h3 class="fs-title">{{ t('filesyncAdmin.title') }}</h3>
        <p class="fs-sub">{{ t('filesyncAdmin.description') }}</p>
      </div>
      <div class="fs-head-actions">
        <div v-if="status" class="fs-setting">
          <div class="fs-setting-copy">
            <span>{{ t('filesyncAdmin.autoSync') }}</span>
            <small>{{ !status.supported ? t('filesyncAdmin.autoSyncUnsupported') : status.featureEnabled ? t('filesyncAdmin.autoSyncEnabled') : t('filesyncAdmin.autoSyncDisabled') }}</small>
          </div>
          <ToggleSwitch
            size="sm"
            :model-value="status.featureEnabled"
            :disabled="syncSaving || !status.supported"
            :aria-label="t('filesyncAdmin.toggleAutoSync')"
            @update:model-value="toggleSync"
          />
        </div>
        <ActionButton variant="secondary" fit :disabled="loading" @click="load">
          <Icon name="action.refresh" size="sm" />
          {{ loading ? t('filesyncAdmin.loading') : t('filesyncAdmin.refresh') }}
        </ActionButton>
      </div>
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
        <div class="fs-block-head">
          <div class="fs-block-title">{{ t('filesyncAdmin.bindingList') }}</div>
          <div class="fs-block-tools">
            <span class="fs-block-stats">{{ t('filesyncAdmin.bindingStats', { shown: visibleBindings.length, total: status.bindings.length }) }}</span>
            <label class="fs-toggle">
              <ToggleSwitch size="sm" :model-value="onlyIssues" :aria-label="t('filesyncAdmin.onlyIssues')" @update:model-value="onlyIssues = $event" />
              <span>{{ t('filesyncAdmin.onlyIssues') }}</span>
            </label>
          </div>
        </div>
        <div v-if="!visibleBindings.length" class="fs-note">{{ t('filesyncAdmin.allHealthy') }}</div>
        <div v-for="binding in visibleBindings" :key="binding.id" class="fs-row">
          <div class="fs-row-main">
            <strong>#{{ binding.id }} · {{ binding.mode }}</strong>
            <span>{{ binding.rootPath }} · {{ binding.userId }}</span>
            <small>{{ t('filesyncAdmin.revision') }} {{ binding.revision }} · {{ t('filesyncAdmin.conflictCount') }} {{ binding.pendingConflicts }}</small>
          </div>
          <div class="fs-actions">
            <ActionButton variant="secondary" fit :disabled="actionKey === `dry-${binding.id}`" @click="dryRun(binding.id)">
              <Icon name="action.search" size="sm" />
              {{ actionKey === `dry-${binding.id}` ? t('filesyncAdmin.working') : t('filesyncAdmin.dryRun') }}
            </ActionButton>
            <ActionButton fit :disabled="actionKey === `sync-${binding.id}`" @click="reconcile(binding.id)">
              <Icon name="action.refresh" size="sm" />
              {{ actionKey === `sync-${binding.id}` ? t('filesyncAdmin.working') : t('filesyncAdmin.reconcile') }}
            </ActionButton>
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
            <ActionButton v-for="resolution in resolutions" :key="resolution.value" variant="secondary" fit
                          :class="{ 'is-danger': resolution.value === 'keep_remote' }"
                          :disabled="actionKey === `conflict-${conflict.id}`" @click="resolve(conflict.id, resolution.value)">
              <Icon :name="resolution.value === 'cancel' ? 'action.close' : 'status.check-circle'" size="sm" />
              {{ t(resolution.label) }}
            </ActionButton>
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
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { filesyncAdminApi, type FileSyncAdminStatus, type FileSyncActionResult } from '@/api/filesync'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import Icon from '@/components/common/icons/Icon.vue'

const { t } = useI18n()
const adminStore = useAdminStore()
const status = ref<FileSyncAdminStatus | null>(null)
const dryResult = ref<FileSyncActionResult | null>(null)
const loading = ref(false)
const syncSaving = ref(false)
const error = ref('')
const actionKey = ref('')
const resolutions = [
  { value: 'keep_local' as const, label: 'filesyncAdmin.keepLocal' },
  { value: 'keep_remote' as const, label: 'filesyncAdmin.keepRemote' },
  { value: 'keep_both' as const, label: 'filesyncAdmin.keepBoth' },
  { value: 'cancel' as const, label: 'filesyncAdmin.cancelConflict' },
]

// 绑定随 workspace 自动登记，健康绑定（无待处理/失败 journal、无冲突）对排查没有
// 信息量；默认只列出有异常的，全量列表留给开关。
const onlyIssues = ref(true)
const visibleBindings = computed(() => {
  const all = status.value?.bindings ?? []
  if (!onlyIssues.value) return all
  return all.filter((binding) =>
    binding.pendingJournal > 0 || binding.failedJournal > 0 ||
    binding.rejectedJournal > 0 || binding.pendingConflicts > 0,
  )
})

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { status.value = await filesyncAdminApi.status(adminStore.authFetch) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { loading.value = false }
}

async function toggleSync(enabled: boolean) {
  if (!status.value || syncSaving.value) return
  const previous = status.value.featureEnabled
  status.value.featureEnabled = enabled
  syncSaving.value = true
  error.value = ''
  try {
    await filesyncAdminApi.setEnabled(adminStore.authFetch, enabled)
    await load()
  } catch (e) {
    status.value.featureEnabled = previous
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncSaving.value = false
  }
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
.fs-card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 20px 22px; margin-bottom: 20px; color: var(--content-primary); font-family: var(--font-sans); font-size: var(--font-size-body); line-height: var(--line-height-body); }
.fs-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
.fs-head-actions { display:flex; align-items:center; justify-content:flex-end; gap:14px; flex-shrink:0; }
.fs-setting { display:flex; align-items:center; gap:9px; }
.fs-setting-copy { display:flex; flex-direction:column; align-items:flex-end; gap:1px; font-size:var(--font-size-sm); white-space:nowrap; }
.fs-setting-copy small { color:var(--content-secondary); font-size:var(--font-size-xs); }
.fs-title { margin:0; font-size:var(--font-size-md); font-weight:var(--font-weight-bold); }
.fs-sub { margin:4px 0 0; font-size:var(--font-size-sm); color:var(--content-secondary); max-width:720px; }
.is-danger { color:var(--status-danger); }
.fs-message { padding:8px 12px; border-radius:8px; font-size:var(--font-size-sm); margin-bottom:10px; }
.fs-message.is-error { color:var(--status-danger); background:color-mix(in srgb,var(--status-danger) 10%,transparent); }
.fs-banner { display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:9px; font-size:var(--font-size-sm); }
.fs-banner.is-ok { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,transparent); }
.fs-banner.is-muted { color:var(--content-secondary); background:var(--control-bg); }
.fs-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:0 0 auto; }
.fs-banner-meta { margin-left:auto; color:var(--content-secondary); }
.fs-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:12px 0; }
.fs-metric { padding:10px 12px; border:1px solid var(--border-subtle); border-radius:9px; background:var(--surface-elevated); }
.fs-metric span { display:block; color:var(--content-secondary); font-size:var(--font-size-xs); margin-bottom:4px; }
.fs-metric b { font-size:var(--font-size-lg); }
.fs-metric b.warn { color:var(--status-warning); }
.fs-note,.fs-footnote { color:var(--content-secondary); font-size:var(--font-size-xs); line-height:var(--line-height-body); }
.fs-block { margin-top:14px; }
.fs-block-title { font-size:var(--font-size-sm); font-weight:var(--font-weight-bold); margin-bottom:7px; }
.fs-block-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:7px; }
.fs-block-head .fs-block-title { margin-bottom:0; }
.fs-block-tools { display:flex; align-items:center; gap:10px; font-size:var(--font-size-xs); color:var(--content-secondary); }
.fs-toggle { display:flex; align-items:center; gap:6px; cursor:pointer; }
.fs-row { display:flex; align-items:center; gap:12px; padding:9px 0; border-top:1px solid var(--border-subtle); }
.fs-row-main { min-width:0; flex:1; display:flex; flex-direction:column; gap:3px; font-size:var(--font-size-sm); }
.fs-row-main strong { overflow-wrap:anywhere; }
.fs-row-main span,.fs-row-main small { color:var(--content-secondary); overflow-wrap:anywhere; }
.fs-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; flex:0 0 auto; }
.fs-result { margin-top:12px; padding:9px 11px; border-radius:9px; color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,transparent); font-size:var(--font-size-sm); }
.fs-failure { border-top:1px solid var(--border-subtle); padding:7px 0; color:var(--status-danger); font-size:var(--font-size-xs); overflow-wrap:anywhere; }
@media (max-width:720px) { .fs-head { flex-direction:column; } .fs-head-actions { width:100%; justify-content:space-between; } .fs-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .fs-row { align-items:flex-start; flex-direction:column; } .fs-actions { justify-content:flex-start; } .fs-banner { align-items:flex-start; flex-wrap:wrap; } .fs-banner-meta { margin-left:0; flex-basis:100%; } .fs-block-head { flex-direction:column; align-items:flex-start; gap:4px; } }
</style>
