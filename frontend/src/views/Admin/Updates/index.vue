<template>
  <div class="updates-page">
    <header class="page-title-block">
      <div>
        <h2 class="page-title">{{ t('adminUpdateUi.title') }}</h2>
        <p class="page-description">{{ t('adminUpdateUi.description') }}</p>
      </div>
      <button class="icon-refresh" :disabled="loading" :title="t('adminUpdateUi.refresh')" @click="loadStatus">
        <Icon name="action.refresh" size="sm" />
      </button>
    </header>

    <div v-if="status" class="scope-note deployment-note" role="status">
      <strong>{{ t(`adminUpdateUi.modes.${status.mode}`) }}</strong>
      <span>{{ t(`adminUpdateUi.reasons.${status.reason_code}`) }}</span>
    </div>
    <div v-if="status?.mode === 'integrated_compose' && status.enabled" class="scope-note">{{ t('adminUpdateUi.sandboxNote') }}</div>
    <div v-if="error" class="error-note" role="status">
      <strong>{{ t('adminUpdateUi.updateUnavailable') }}</strong>
      <span>{{ error }}</span>
    </div>
    <div v-if="!status && error" class="error-note secondary" role="note">{{ t('adminUpdateUi.updaterUnavailable') }}</div>

    <UpdateOverview
      v-if="!status || status.enabled"
      :current-version="currentVersion"
      :candidate="candidate"
      :has-update="hasUpdate"
      :check-result="checkResult?.has_update ?? null"
      :preflight="preflight"
      :checking="checking"
      :loading="loading"
      :preflighting="preflighting"
      :action="action"
      @check="checkForUpdates"
      @preflight="runPreflight"
      @start="confirmAndStartUpdate"
    />

    <UpdateTask
      v-if="!status || status.enabled"
      :task="status?.task ?? null"
      :history="status?.history ?? []"
      :loading="loading"
      :action="action"
      @refresh="loadStatus"
      @rollback="confirmAndStartRollback"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import Icon from '@/components/common/icons/Icon.vue'
import UpdateOverview from './components/UpdateOverview.vue'
import UpdateTask from './components/UpdateTask.vue'
import { useAdminUpdates } from './useAdminUpdates'

const { t } = useI18n()
const {
  status, checkResult, preflight, rollbackPreflight, loading, checking, preflighting,
  action, error, hasUpdate, loadStatus, checkForUpdates, runPreflight, startUpdate,
  prepareRollback, startRollback,
} = useAdminUpdates()

const candidate = computed(() => status.value?.candidate ?? checkResult.value?.candidate ?? null)
const currentVersion = computed(() => status.value?.current?.version ?? checkResult.value?.current.version ?? '')

async function confirmAndStartUpdate() {
  const target = candidate.value?.version
  if (!target || !preflight.value?.challenge) return
  const confirmed = await confirmDialog({
    title: t('adminUpdateUi.confirmUpdateTitle'),
    message: `${t('adminUpdateUi.confirmUpdateMessage', { current: currentVersion.value || t('adminUpdateUi.currentUnknown'), target })}\n\n${t('adminUpdateUi.migrationWarning')}`,
    tone: 'warning',
    confirmText: t('adminUpdateUi.beginUpdate'),
  })
  if (!confirmed) return
  try { await startUpdate() } catch { /* 错误已由更新状态卡呈现 */ }
}

async function confirmAndStartRollback() {
  await prepareRollback()
  if (!rollbackPreflight.value?.ready || !rollbackPreflight.value.challenge) return
  const confirmed = await confirmDialog({
    title: t('adminUpdateUi.confirmRollbackTitle'),
    message: `${t('adminUpdateUi.confirmRollbackMessage', { target: rollbackPreflight.value.target_version })}\n\n${t('adminUpdateUi.migrationWarning')}`,
    tone: 'danger',
    confirmText: t('adminUpdateUi.confirmRollback'),
  })
  if (!confirmed) return
  try { await startRollback() } catch { /* 错误已由更新状态卡呈现 */ }
}
</script>

<style scoped>
.updates-page { display: flex; flex-direction: column; gap: 16px; padding: 28px 32px; color: var(--content-primary); }
.page-title-block { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.page-title { margin: 0; color: var(--content-primary); font-size: 22px; font-weight: 700; line-height: 1.2; }
.page-description { margin: 6px 0 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.55; }
.icon-refresh { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-secondary); cursor: pointer; }
.icon-refresh:disabled { opacity: .5; cursor: default; }
.scope-note, .error-note { padding: 11px 14px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-md); background: var(--panel-glass-bg); color: var(--content-secondary); font-size: 12px; line-height: 1.55; }
.deployment-note { display: flex; flex-direction: column; gap: 4px; }
.deployment-note strong { color: var(--content-primary); }
.error-note { display: flex; flex-direction: column; gap: 4px; border-color: color-mix(in srgb, var(--status-danger) 32%, transparent); background: color-mix(in srgb, var(--status-danger) 8%, var(--panel-glass-bg)); color: var(--status-danger); }
.error-note span { color: var(--content-secondary); overflow-wrap: anywhere; }
.error-note.secondary { display: block; }
@media (max-width: 720px) { .updates-page { padding: 20px 16px; } }
</style>
