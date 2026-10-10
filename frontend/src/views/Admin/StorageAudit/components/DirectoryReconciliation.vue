<template>
  <section class="sa-card">
    <div class="sa-card-head">
      <div>
        <h3 class="sa-card-title">{{ t('storageAuditUi.dirTitle') }}</h3>
        <p class="sa-card-sub">{{ t('storageAuditUi.dirHint') }}</p>
      </div>
      <div class="sa-card-head-right">
        <input v-model.trim="userId" class="sa-input" :placeholder="t('storageAuditUi.userId')" @keyup.enter="scanDirs()" />
        <ActionButton variant="secondary" fit :disabled="scanning" @click="scanDirs()">
          <Icon name="action.search" size="sm" />
          {{ scanning ? t('storageAuditUi.reconciling') : t('storageAudit.scan') }}
        </ActionButton>
      </div>
    </div>

    <div v-if="error" class="sa-inline-msg err">{{ error }}</div>

    <template v-if="report">
      <div class="fd-banner" :class="report.healthy ? 'ok' : 'alert'">
        <Icon v-if="report.healthy" name="status.check-circle" size="md" />
        <Icon v-else name="status.warning" size="md" />
        <span v-if="report.healthy">{{ t('storageAuditUi.healthy') }}</span>
        <span v-else>
          {{ t('storageAuditExtra.found') }}
          <b v-if="report.missing_dirs.length">{{ t('storageAuditExtra.missingCount', { count: report.missing_dirs.length }) }}</b>
          <span v-if="report.missing_dirs.length && (report.orphan_dirs.length || report.misplaced_files.length)">、</span>
          <b v-if="report.orphan_dirs.length">{{ t('storageAuditExtra.orphanCount', { count: report.orphan_dirs.length }) }}</b>
          <span v-if="report.orphan_dirs.length && report.misplaced_files.length">、</span>
          <b v-if="report.misplaced_files.length">{{ t('storageAuditExtra.misplacedCount', { count: report.misplaced_files.length }) }}</b>。
        </span>
      </div>

      <div class="fd-cards">
        <div class="fd-card">
          <div class="fc-label">{{ t('storageAuditExtra.scannedFolders') }}</div>
          <div class="fc-value">{{ report.scanned_folders }}</div>
        </div>
        <div class="fd-card" :class="{ warnMiss: report.missing_dirs.length }">
          <div class="fc-label">{{ t('storageAuditUi.missingDirs') }}</div>
          <div class="fc-value">{{ report.missing_dirs.length }}</div>
          <div class="fc-hint">{{ t('storageAuditExtra.missingHint') }}</div>
        </div>
        <div class="fd-card" :class="{ warnOrphan: report.orphan_dirs.length }">
          <div class="fc-label">{{ t('storageAuditUi.orphanDirs') }}</div>
          <div class="fc-value">{{ report.orphan_dirs.length }}</div>
          <div class="fc-hint">{{ t('storageAuditExtra.orphanHint') }}</div>
        </div>
        <div class="fd-card" :class="{ warnOrphan: report.misplaced_files.length }">
          <div class="fc-label">{{ t('storageAuditUi.misplacedFiles') }}</div>
          <div class="fc-value">{{ report.misplaced_files.length }}</div>
          <div class="fc-hint">{{ t('storageAuditExtra.misplacedCardHint') }}</div>
        </div>
      </div>

      <div v-if="lastFix" class="fd-fix-result">
        <Icon name="status.check-circle" size="sm" />
        {{ t('storageAuditExtra.lastFix', { created: lastFix.created, removed: lastFix.removed, relocated: lastFix.relocated }) }}
      </div>

      <div v-if="report.missing_dirs.length" class="fd-section">
        <div class="sec-title miss">{{ t('storageAuditExtra.missingSection') }}</div>
        <ul class="dir-list"><li v-for="dir in report.missing_dirs" :key="dir" class="dir-item">{{ dir }}</li></ul>
      </div>

      <div v-if="report.orphan_dirs.length" class="fd-section">
        <div class="sec-title orphan">{{ t('storageAuditExtra.orphanSection') }}</div>
        <ul class="dir-list"><li v-for="dir in report.orphan_dirs" :key="dir" class="dir-item">{{ dir }}</li></ul>
        <Checkbox v-model="removeOrphans" class="fd-confirm">{{ t('storageAuditUi.confirmOrphans') }}</Checkbox>
      </div>

      <div v-if="report.misplaced_files.length" class="fd-section">
        <div class="sec-title orphan">{{ t('storageAuditExtra.misplacedSection') }}</div>
        <ul class="dir-list">
          <li v-for="item in report.misplaced_files" :key="item.file_id" class="dir-item misplaced-item">
            <div class="misplaced-name">{{ item.display_name }}（#{{ item.file_id }}）</div>
            <div class="misplaced-path"><span class="from">{{ item.current_key }}</span> → <span class="to">{{ item.expected_key }}</span></div>
          </li>
        </ul>
        <Checkbox v-model="relocateFiles" class="fd-confirm">{{ t('storageAuditExtra.relocateConfirm') }}</Checkbox>
      </div>

      <div v-if="!report.healthy" class="fd-actions">
        <ActionButton :disabled="fixing" fit @click="repairDirs()">
          <Icon name="admin.wrench" size="sm" />{{ fixButtonLabel }}
        </ActionButton>
        <span class="fd-actions-note">{{ t('storageAuditExtra.actionsNote') }}</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import { useAdminStore } from '@/stores/admin'

interface MisplacedFile { file_id: number; display_name: string; current_key: string; expected_key: string }
interface DoctorReport {
  missing_dirs: string[]
  orphan_dirs: string[]
  misplaced_files: MisplacedFile[]
  scanned_folders: number
  created: number
  removed: number
  relocated: number
  healthy: boolean
}

const adminStore = useAdminStore()
const { t } = useI18n()
const userId = ref('')
const report = ref<DoctorReport | null>(null)
const lastFix = ref<{ created: number; removed: number; relocated: number } | null>(null)
const removeOrphans = ref(false)
const relocateFiles = ref(false)
const scanning = ref(false)
const fixing = ref(false)
const error = ref('')

const fixButtonLabel = computed(() => {
  const parts: string[] = []
  if (report.value?.missing_dirs.length) parts.push(t('storageAuditExtra.actionMissing'))
  if (removeOrphans.value && report.value?.orphan_dirs.length) parts.push(t('storageAuditExtra.actionOrphan'))
  if (relocateFiles.value && report.value?.misplaced_files.length) parts.push(t('storageAuditExtra.actionRelocate'))
  return parts.length ? t('storageAuditExtra.actionWithParts', { parts: parts.join(' + ') }) : t('storageAuditExtra.noAction')
})

function queryString() { return userId.value ? `?user_id=${encodeURIComponent(userId.value)}` : '' }

async function scanDirs() {
  scanning.value = true
  error.value = ''
  lastFix.value = null
  removeOrphans.value = false
  relocateFiles.value = false
  try {
    const response = await adminStore.authFetch(`/api/v1/admin/folder-doctor/scan${queryString()}`)
    if (!response.ok) throw new Error(t('storageAuditExtra.scanFailed', { message: `(${response.status})` }))
    report.value = await response.json()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    report.value = null
  } finally {
    scanning.value = false
  }
}

async function repairDirs() {
  fixing.value = true
  error.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/folder-doctor/repair', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId.value || null,
        remove_orphans: removeOrphans.value,
        relocate_files: relocateFiles.value,
      }),
    })
    if (!response.ok) throw new Error(t('storageAuditExtra.repairFailure', { message: `(${response.status})` }))
    const fresh: DoctorReport = await response.json()
    lastFix.value = { created: fresh.created, removed: fresh.removed, relocated: fresh.relocated }
    report.value = fresh
    removeOrphans.value = false
    relocateFiles.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    fixing.value = false
  }
}
</script>

<style scoped>
.sa-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 20px 22px; margin-bottom: 20px; }
.sa-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.sa-card-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); margin: 0; }
.sa-card-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 560px; }
.sa-card-head-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.sa-input { width: 220px; font-size: var(--font-size-sm); padding: 7px 11px; border-radius: 9px; outline: none; }
.sa-inline-msg { font-size: var(--font-size-sm); margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; }
.sa-inline-msg.err { color: var(--status-danger); background: var(--status-danger-bg); border: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent); }
.fd-banner { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: var(--font-size-sm); }
.fd-banner.ok { background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 25%, transparent); color: var(--status-success); }
.fd-banner.alert { background: var(--status-warning-bg); border: 1px solid color-mix(in srgb, var(--status-warning) 30%, transparent); color: var(--status-warning); }
.fd-banner b { font-weight: var(--font-weight-bold); }
.fd-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.fd-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px 16px; }
.fd-card.warnMiss { border-color: rgba(120,150,210,0.4); background: rgba(120,150,210,0.08); }
.fd-card.warnOrphan { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.fc-label { font-size: var(--font-size-sm); color: var(--content-secondary); margin-bottom: 8px; }
.fc-value { font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); line-height: var(--line-height-tight); }
.fc-hint { font-size: var(--font-size-xs); color: var(--content-secondary); margin-top: 6px; }
.fd-fix-result { display: flex; align-items: center; gap: 8px; font-size: var(--font-size-sm); color: var(--status-success); margin-bottom: 16px; background: rgba(90,180,120,0.08); border: 1px solid rgba(90,180,120,0.2); border-radius: 10px; padding: 10px 14px; }
.fd-section { margin-bottom: 18px; }
.sec-title { font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); margin-bottom: 10px; }
.sec-title.miss { color: var(--status-info); }
.sec-title.orphan { color: var(--status-warning); }
.dir-list { list-style: none; margin: 0; padding: 8px; max-height: 240px; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
.dir-item { font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--content-primary); padding: 4px 8px; border-radius: 6px; word-break: break-all; }
.dir-item:hover { background: rgba(255,255,255,0.04); }
.misplaced-item { padding: 6px 8px; }
.misplaced-name { font-family: var(--font-sans); font-weight: var(--font-weight-semibold); color: var(--content-primary); margin-bottom: 2px; }
.misplaced-path { font-size: var(--font-size-xs); }
.misplaced-path .from { color: var(--status-warning); }
.misplaced-path .to { color: var(--status-success); }
.fd-confirm { margin-top: 12px; font-size: var(--font-size-sm); color: var(--content-secondary); }
.fd-actions { display: flex; align-items: center; gap: 14px; margin-top: 4px; flex-wrap: wrap; }
.fd-actions-note { font-size: var(--font-size-sm); color: var(--content-secondary); }
@media (max-width: 760px) { .sa-card-head { flex-wrap: wrap; } .sa-card-head-right { width: 100%; } .sa-input { min-width: 0; flex: 1; } }
</style>
