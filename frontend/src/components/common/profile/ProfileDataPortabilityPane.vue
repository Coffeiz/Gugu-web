<template>
  <section class="pm-section data-pane">
    <h3 class="pm-section-label">{{ t('profileDataUi.title') }}</h3>
    <p class="data-intro">{{ t('profileDataUi.intro') }}</p>

    <div v-if="preview" class="data-summary">
      <div v-for="category in visibleCategories" :key="category" class="data-summary-row">
        <span>{{ t(`profileDataUi.category_${category}`) }}</span>
        <span>{{ t('profileDataUi.records', { count: preview.categories[category]?.records ?? 0 }) }}</span>
      </div>
      <div class="data-summary-total">{{ t('profileDataUi.estimatedBytes', { size: formatBytes(totalBytes) }) }}</div>
    </div>
    <p v-else-if="loading" class="data-muted">{{ t('profileDataUi.preview') }}</p>
    <p v-if="error" class="pm-msg err">{{ error }}</p>

    <div class="data-options">
      <Checkbox v-model="includeDrafts" class="data-option">{{ t('profileDataUi.includeDrafts') }}</Checkbox>
      <Checkbox v-model="includeImMemory" class="data-option">{{ t('profileDataUi.includeImMemory') }}</Checkbox>
    </div>
    <p class="data-warning">{{ t('profileDataUi.sensitiveHint') }}</p>
    <p class="data-muted">{{ t('profileDataUi.credentialsHint') }}</p>

    <div class="data-actions">
      <button class="pm-save-btn" :disabled="creating || loading" @click="createExport">
        {{ creating ? t('profileDataUi.creating') : t('profileDataUi.createExport') }}
      </button>
    </div>

    <div class="data-import">
      <h4>{{ t('profileDataUi.importTitle') }}</h4>
      <p class="data-muted">{{ t('profileDataUi.importHint') }}</p>
      <div class="data-import-actions">
        <input ref="archiveInput" type="file" accept=".zip,application/zip" :disabled="importing" @change="selectArchive" />
        <button class="pm-style-chip" :disabled="!selectedArchive || importing" @click="preflightImport">
          {{ importing ? t('profileDataUi.importing') : t('profileDataUi.preflight') }}
        </button>
      </div>
      <article v-if="importJob" class="data-job">
        <div class="data-job-copy">
          <strong>{{ t(`profileDataUi.${importStatusKey}`) }}</strong>
          <small v-if="importJob.preview">
            {{ t('profileDataUi.importCounts', { add: plannedImportCounts.add, skip: plannedImportCounts.skip }) }}
          </small>
          <small v-if="importJob.preview?.conflicts?.total" class="data-conflict">
            {{ t('profileDataUi.importConflicts', { count: importJob.preview.conflicts.total }) }}
          </small>
          <small v-if="importJob.preview?.complete && importJob.preview.replace">
            {{ t('profileDataUi.replaceCounts', { current: replaceCurrentTotal, incoming: replaceIncomingTotal }) }}
          </small>
          <small v-if="['queued', 'running', 'applying', 'rolling_back'].includes(importJob.status) && importJob.progress_total">
            {{ importJob.progress_current }} / {{ importJob.progress_total }}
          </small>
          <small v-if="importJob.status === 'completed' && importJob.mode === 'replace' && importJob.rollback_expires_at">
            {{ t('profileDataUi.rollbackUntil', { date: formatDate(importJob.rollback_expires_at) }) }}
          </small>
          <small v-if="importJob.status === 'needs_recovery'">{{ t('profileDataUi.needsRecovery') }}</small>
          <small v-if="importJob.status === 'failed'">{{ t('profileDataUi.importFailed') }}</small>
        </div>
        <div class="data-job-actions">
          <button v-if="importJob.status === 'preview_ready' && importToken" class="pm-save-btn" :disabled="applying || Boolean(importJob.preview?.conflicts?.total)" @click="applyIncremental">
            {{ applying ? t('profileDataUi.importing') : t('profileDataUi.incrementalImport') }}
          </button>
          <button v-if="importJob.status === 'preview_ready' && importToken && importJob.preview?.complete" class="pm-style-chip replace-action" :disabled="applying" @click="applyReplace">
            {{ applying ? t('profileDataUi.importing') : t('profileDataUi.replaceCurrent') }}
          </button>
          <button v-else-if="importJob.status === 'queued'" class="pm-style-chip" @click="cancelImport">
            {{ t('profileDataUi.cancel') }}
          </button>
        </div>
      </article>
    </div>

    <div class="data-jobs">
      <h4>{{ t('profileDataUi.jobs') }}</h4>
      <p v-if="jobs.length === 0 && !loadingJobs" class="data-muted">{{ t('profileDataUi.empty') }}</p>
      <article v-for="job in jobs" :key="job.id" class="data-job">
        <div class="data-job-copy">
          <strong>{{ statusLabel(job.status) }}</strong>
          <small v-if="job.expires_at && job.status === 'ready'">{{ t('profileDataUi.expires', { date: formatDate(job.expires_at) }) }}</small>
          <small v-if="job.status === 'failed'">{{ t('profileDataUi.exportFailed') }}</small>
          <small v-if="job.status === 'running' && job.progress_total">{{ job.progress_current }} / {{ job.progress_total }}</small>
        </div>
        <div class="data-job-actions">
          <button v-if="job.download_available" class="pm-style-chip" :disabled="downloading === job.id" @click="download(job)">
            {{ downloading === job.id ? t('common.status.loading') : t('profileDataUi.download') }}
          </button>
          <button v-else-if="['queued', 'running'].includes(job.status)" class="pm-style-chip" :disabled="canceling === job.id" @click="cancel(job)">
            {{ t('profileDataUi.cancel') }}
          </button>
          <button v-if="!['queued', 'running', 'canceling'].includes(job.status)" class="pm-style-chip delete-export" :disabled="deleting === job.id" @click="deleteExport(job)">
            {{ deleting === job.id ? t('profileDataUi.deleting') : t('profileDataUi.deleteExport') }}
          </button>
        </div>
      </article>
      <article v-for="job in importJobs" :key="job.id" class="data-job">
        <div class="data-job-copy">
          <strong>{{ t(`profileDataUi.${jobStatusKey(job.status)}`) }}</strong>
          <small>{{ t('profileDataUi.importJobMode', { mode: t(`profileDataUi.mode_${job.mode}`) }) }}</small>
          <small v-if="job.status === 'completed' && job.mode === 'replace' && job.rollback_expires_at">
            {{ t('profileDataUi.rollbackUntil', { date: formatDate(job.rollback_expires_at) }) }}
          </small>
        </div>
        <div class="data-job-actions">
          <button v-if="job.status === 'completed' && job.mode === 'replace' && job.rollback_expires_at && new Date(job.rollback_expires_at) > new Date()" class="pm-style-chip replace-action" :disabled="applying" @click="rollbackReplace(job)">
            {{ t('profileDataUi.undoReplace') }}
          </button>
          <button v-if="job.status === 'needs_recovery'" class="pm-style-chip replace-action" :disabled="applying" @click="recoverImport(job)">
            {{ t('profileDataUi.recover') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { dataPortabilityApi, type DataExportJob, type DataImportJob } from '@/services/api'

const { t } = useI18n()
const preview = ref<Awaited<ReturnType<typeof dataPortabilityApi.preview>> | null>(null)
const jobs = ref<DataExportJob[]>([])
const importJobs = ref<DataImportJob[]>([])
const loading = ref(true)
const loadingJobs = ref(true)
const creating = ref(false)
const canceling = ref('')
const deleting = ref('')
const downloading = ref('')
const selectedArchive = ref<File | null>(null)
const archiveInput = ref<HTMLInputElement | null>(null)
const importJob = ref<DataImportJob | null>(null)
const importToken = ref('')
const importing = ref(false)
const applying = ref(false)
const error = ref('')
const includeDrafts = ref(true)
const includeImMemory = ref(true)
let pollTimer: ReturnType<typeof setInterval> | undefined

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `data-portability-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const visibleCategories = computed(() => Object.keys(preview.value?.categories ?? {}).filter(key =>
  !['archive_docs', 'drafts', 'im_memory'].includes(key),
))
const totalBytes = computed(() => Object.values(preview.value?.categories ?? {}).reduce((sum, value) => sum + value.bytes, 0))
const plannedImportCounts = computed(() => ({
  add: (importJob.value?.preview?.incremental?.add_total ?? 0) + (importJob.value?.preview?.memory?.add_total ?? 0),
  skip: (importJob.value?.preview?.incremental?.skip_total ?? 0) + (importJob.value?.preview?.memory?.skip_total ?? 0),
}))
const replaceCurrentTotal = computed(() => Object.values(importJob.value?.preview?.replace?.current ?? {}).reduce((sum, count) => sum + count, 0))
const replaceIncomingTotal = computed(() => Object.values(importJob.value?.preview?.replace?.incoming ?? {}).reduce((sum, count) => sum + count, 0))

onMounted(async () => {
  await Promise.all([loadPreview(), loadJobs(), loadImportJobs()])
  pollTimer = setInterval(() => { void loadJobs(); void loadImportJobs(); void pollImport() }, 3000)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })

async function loadPreview() {
  loading.value = true
  try { preview.value = await dataPortabilityApi.preview() }
  catch { error.value = t('profileDataUi.previewFailed') }
  finally { loading.value = false }
}

async function loadJobs() {
  try { jobs.value = await dataPortabilityApi.listExports() }
  catch { if (!jobs.value.length) error.value = t('profileDataUi.loadFailed') }
  finally { loadingJobs.value = false }
}

async function loadImportJobs() {
  try { importJobs.value = await dataPortabilityApi.listImports() }
  catch { /* keep the last visible history while the endpoint is temporarily unavailable */ }
}

async function createExport() {
  if (!preview.value || creating.value) return
  const confirmed = await confirmDialog({
    title: t('profileDataUi.confirmTitle'),
    message: t('profileDataUi.confirmMessage'),
    tone: 'warning',
    confirmText: t('profileDataUi.confirm'),
  })
  if (!confirmed) return
  creating.value = true
  error.value = ''
  try {
    const categories = Object.keys(preview.value.categories).filter(key => key !== 'archive_docs')
    if (!includeDrafts.value) categories.splice(categories.indexOf('drafts'), 1)
    if (!includeImMemory.value) categories.splice(categories.indexOf('im_memory'), 1)
    await dataPortabilityApi.createExport(categories, createIdempotencyKey())
    await loadJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.createFailed')
  } finally { creating.value = false }
}

async function cancel(job: DataExportJob) {
  canceling.value = job.id
  error.value = ''
  try { await dataPortabilityApi.cancelExport(job.id); await loadJobs() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('profileDataUi.cancelFailed') }
  finally { canceling.value = '' }
}

async function deleteExport(job: DataExportJob) {
  const confirmed = await confirmDialog({
    title: t('profileDataUi.deleteConfirmTitle'),
    message: t('profileDataUi.deleteConfirmMessage'),
    tone: 'warning',
    confirmText: t('profileDataUi.deleteExport'),
  })
  if (!confirmed) return
  deleting.value = job.id
  error.value = ''
  try { await dataPortabilityApi.deleteExport(job.id); await loadJobs() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('profileDataUi.deleteFailed') }
  finally { deleting.value = '' }
}

async function download(job: DataExportJob) {
  downloading.value = job.id
  error.value = ''
  let writable: { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> } | null = null
  try {
    const pickerWindow = window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<typeof writable> }> }
    if (!pickerWindow.showSaveFilePicker) {
      const { url } = await dataPortabilityApi.createBrowserDownloadTicket(job.id)
      window.location.assign(url)
      return
    }
    const handle = await pickerWindow.showSaveFilePicker({ suggestedName: `gugu-export-${job.id.slice(0, 12)}.zip` })
    writable = await handle.createWritable()
    const response = await dataPortabilityApi.downloadExport(job.id)
    if (!response.body) throw new Error(t('profileDataUi.downloadFailed'))
    if (writable) {
      const writer = writable
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writer.write(value)
        }
        await writer.close()
      } catch (cause) {
        await writer.abort()
        throw cause
      }
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.downloadFailed')
  } finally { downloading.value = '' }
}

function selectArchive(event: Event) {
  selectedArchive.value = (event.target as HTMLInputElement).files?.[0] ?? null
  importJob.value = null
  importToken.value = ''
}

async function preflightImport() {
  if (!selectedArchive.value || importing.value) return
  importing.value = true
  error.value = ''
  try {
    const result = await dataPortabilityApi.preflightImport(selectedArchive.value)
    importJob.value = result
    importToken.value = result.import_token ?? ''
    selectedArchive.value = null
    if (archiveInput.value) archiveInput.value.value = ''
    await pollImport()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.preflightFailed')
  } finally { importing.value = false }
}

async function pollImport() {
  if (!importJob.value || !['queued', 'running', 'applying', 'rolling_back'].includes(importJob.value.status)) return
  try { importJob.value = await dataPortabilityApi.getImport(importJob.value.id) }
  catch { /* keep the last visible task state; the next poll can recover */ }
}

async function applyReplace() {
  if (!importJob.value || !importToken.value || !importJob.value.preview?.complete || applying.value) return
  const confirmed = await confirmDialog({
    title: t('profileDataUi.replaceConfirmTitle'),
    message: t('profileDataUi.replaceConfirmMessage', {
      current: replaceCurrentTotal.value,
      incoming: replaceIncomingTotal.value,
    }),
    tone: 'warning',
    confirmText: t('profileDataUi.replaceCurrent'),
  })
  if (!confirmed) return
  applying.value = true
  error.value = ''
  try {
    importJob.value = await dataPortabilityApi.applyImport(
      importJob.value.id, 'replace', importToken.value, createIdempotencyKey(),
    )
    importToken.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function applyIncremental() {
  if (!importJob.value || !importToken.value || applying.value) return
  const confirmed = await confirmDialog({
    title: t('profileDataUi.incrementalConfirmTitle'),
    message: t('profileDataUi.incrementalConfirmMessage', {
      add: plannedImportCounts.value.add,
      skip: plannedImportCounts.value.skip,
    }),
    tone: 'warning',
    confirmText: t('profileDataUi.incrementalImport'),
  })
  if (!confirmed) return
  applying.value = true
  error.value = ''
  try {
    importJob.value = await dataPortabilityApi.applyImport(
      importJob.value.id, 'incremental', importToken.value, createIdempotencyKey(),
    )
    importToken.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function cancelImport() {
  if (!importJob.value) return
  try { importJob.value = await dataPortabilityApi.cancelImport(importJob.value.id); importToken.value = '' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('profileDataUi.cancelFailed') }
}

async function rollbackReplace(job: DataImportJob) {
  const confirmed = await confirmDialog({
    title: t('profileDataUi.undoConfirmTitle'),
    message: t('profileDataUi.undoConfirmMessage'),
    tone: 'warning',
    confirmText: t('profileDataUi.undoReplace'),
  })
  if (!confirmed || applying.value) return
  applying.value = true
  error.value = ''
  try {
    importJob.value = await dataPortabilityApi.rollbackImport(job.id, createIdempotencyKey())
    await loadImportJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function recoverImport(job: DataImportJob) {
  applying.value = true
  error.value = ''
  try {
    importJob.value = await dataPortabilityApi.recoverImport(job.id)
    await loadImportJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

const importStatusKey = computed(() => {
  const status = importJob.value?.status ?? 'queued'
  return ({ preview_ready: 'previewReady', completed: 'importCompleted' } as Record<string, string>)[status]
    ?? (['queued', 'running', 'failed', 'canceled'].includes(status) ? status : 'running')
})

function statusLabel(status: string) {
  const key = ['queued', 'running', 'ready', 'failed', 'canceled'].includes(status) ? status : 'running'
  return t(`profileDataUi.${key}`)
}
function jobStatusKey(status: string) {
  if (status === 'completed') return 'importCompleted'
  if (status === 'rolled_back') return 'rolledBack'
  if (status === 'preview_ready') return 'previewReady'
  if (status === 'needs_recovery') return 'needsRecovery'
  return ['queued', 'running', 'failed', 'canceled'].includes(status) ? status : 'running'
}
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) }
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = value / 1024
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return `${amount.toFixed(1)} ${units[unit]}`
}
</script>

<style scoped>
.data-pane { display: flex; flex-direction: column; gap: 12px; }
.replace-action { color: var(--pm-danger-text, #a44949); }
.delete-export { color: var(--pm-danger-text, #a44949); }
.data-intro, .data-muted, .data-warning { margin: 0; color: var(--content-secondary); font-size: 13px; line-height: 1.55; }
.data-muted { color: var(--content-tertiary); }
.data-warning { color: var(--warning-text, var(--content-secondary)); }
.data-conflict { color: var(--pm-danger-text, #a44949) !important; }
.data-summary { border: 1px solid var(--subpanel-border); background: var(--subpanel-bg); border-radius: var(--radius-md); padding: 12px 14px; }
.data-summary-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; color: var(--content-secondary); }
.data-summary-total { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--panel-divider); font-size: 12px; color: var(--content-tertiary); }
.data-options { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
.data-option { color: var(--content-primary); font-size: 13px; }
.data-actions { display: flex; justify-content: flex-end; }
.data-import { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--panel-divider); display: flex; flex-direction: column; gap: 8px; }
.data-import h4 { margin: 0; font-size: 13px; color: var(--content-primary); }
.data-import-actions { display: flex; align-items: center; gap: 8px; }
.data-import-actions input[type='file'] { min-width: 0; flex: 1; color: var(--content-secondary); font: 13px var(--font-sans); }
.data-import-actions input[type='file']::file-selector-button {
  margin-inline-end: 8px;
  padding: 6px 10px;
  border: 1px solid var(--choice-chip-border);
  border-radius: var(--choice-chip-radius);
  background: var(--choice-chip-bg);
  color: var(--choice-chip-fg);
  font: 500 12px var(--font-sans);
  cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.data-import-actions input[type='file']:not(:disabled)::file-selector-button:hover {
  background: var(--choice-chip-bg-hover);
  border-color: var(--choice-chip-border-hover);
  color: var(--choice-chip-fg-hover);
}
.data-import-actions input[type='file']:focus-visible { outline: 2px solid var(--action-primary); outline-offset: 2px; }
.data-import-actions input[type='file']:disabled { opacity: .55; }
.data-import-actions input[type='file']:disabled::file-selector-button { cursor: not-allowed; }
.data-jobs { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--panel-divider); }
.data-jobs h4 { margin: 0 0 10px; font-size: 13px; color: var(--content-primary); }
.data-job { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--panel-divider); }
.data-job-copy { display: flex; flex-direction: column; gap: 4px; color: var(--content-primary); font-size: 13px; }
.data-job-copy small { color: var(--content-tertiary); font-size: 11px; }
.data-job-actions { display: flex; gap: 8px; }
</style>
