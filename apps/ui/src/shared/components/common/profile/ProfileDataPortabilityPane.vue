<template>
  <section class="pm-section data-pane">
    <h3 class="pm-section-label">{{ t('profileDataUi.title') }}</h3>
    <p class="data-intro">{{ t(desktop ? 'profileDataUi.desktopArchiveUnavailable' : 'profileDataUi.intro') }}</p>

    <div v-if="preview || inventory" class="data-summary">
      <div v-for="category in visibleCategories" :key="category" class="data-summary-row">
        <span>{{ t(`profileDataUi.category_${category}`) }}</span>
        <span>{{ t(desktop && category === 'owner_memory' ? 'profileDataUi.desktopMemoryFiles' : 'profileDataUi.records', { count: inventory?.[category] ?? preview?.categories[category]?.records ?? 0 }) }}</span>
      </div>
      <div v-if="preview" class="data-summary-total">{{ t('profileDataUi.estimatedBytes', { size: formatBytes(totalBytes) }) }}</div>
    </div>
    <p v-else-if="loading" class="data-muted">{{ t('profileDataUi.preview') }}</p>
    <p v-if="error" class="pm-msg err">{{ error }}</p>

    <div class="data-options">
      <Checkbox v-model="includeDrafts" :disabled="desktop" class="data-option">{{ t('profileDataUi.includeDrafts') }}</Checkbox>
      <Checkbox v-model="includeImMemory" :disabled="desktop" class="data-option">{{ t('profileDataUi.includeImMemory') }}</Checkbox>
    </div>
    <p class="data-muted">{{ t(desktop ? 'profileDataUi.desktopFileHint' : 'profileDataUi.fileExportHint') }}</p>
    <p class="data-warning">{{ t('profileDataUi.sensitiveHint') }}</p>
    <p class="data-muted">{{ t('profileDataUi.credentialsHint') }}</p>

    <div class="data-actions">
      <button class="pm-save-btn" :disabled="creating || loading || (desktop && (!inventory || !local?.exportBusinessArchive))" @click="createExport">
        {{ creating ? t('profileDataUi.creating') : t('profileDataUi.createExport') }}
      </button>
    </div>

    <div class="data-import">
      <h4>{{ t('profileDataUi.importTitle') }}</h4>
      <p class="data-muted">{{ t(desktop ? 'profileDataUi.desktopImportHint' : 'profileDataUi.importHint') }}</p>
      <div class="data-import-actions">
        <input v-if="!desktop" ref="archiveInput" type="file" accept=".zip,application/zip" :disabled="importing" @change="selectArchive" />
        <button class="pm-style-chip" :disabled="importing || (desktop && applying) || (desktop ? !local?.preflightBusinessArchive : !selectedArchive)" @click="preflightImport">
          {{ importing ? t('profileDataUi.importing') : t('profileDataUi.preflight') }}
        </button>
      </div>
      <article v-if="desktopPreflight" class="data-job" role="status">
        <div class="data-job-copy">
          <strong>{{ t(desktopPreflight.completed ? 'profileDataUi.importCompleted' : 'profileDataUi.previewReady') }}</strong>
          <small>{{ t(desktopPreflight.completed ? 'profileDataUi.desktopImportCounts' : 'profileDataUi.importCounts', {
            add: desktopPreflight.added, skip: desktopPreflight.skipped,
          }) }}</small>
        </div>
        <div v-if="!desktopPreflight.completed && local?.applyBusinessArchive" class="data-job-actions">
          <button class="pm-save-btn" :disabled="applying || importing" @click="applyIncremental()">
            {{ applying ? t('profileDataUi.importing') : t('profileDataUi.incrementalImport') }}
          </button>
        </div>
      </article>
    </div>

    <div v-if="!desktop" class="data-jobs">
      <h4>{{ t('profileDataUi.importJobs') }}</h4>
      <p v-if="importJobs.length === 0 && !loadingJobs" class="data-muted">{{ t('profileDataUi.importEmpty') }}</p>
      <article v-for="job in importJobs" :key="job.id" class="data-job">
        <div class="data-job-copy">
          <strong>{{ t(`profileDataUi.${isPreflightExpired(job) ? 'preflightExpired' : jobStatusKey(job.status)}`) }}</strong>
          <small>{{ t('profileDataUi.importJobMode', { mode: t(`profileDataUi.mode_${job.mode}`) }) }}</small>
          <template v-if="job.status === 'preview_ready' && job.preview">
            <small>{{ t('profileDataUi.importCounts', { add: plannedImportCounts(job).add, skip: plannedImportCounts(job).skip }) }}</small>
            <small v-if="job.preview.conflicts?.total" class="data-conflict">
              {{ t('profileDataUi.importConflicts', { count: job.preview.conflicts.total }) }}
            </small>
            <small v-if="job.preview.compatibility?.mind_refs_as_notes" class="data-muted">
              {{ t('profileDataUi.mindRefsAsNotes', { count: job.preview.compatibility.mind_refs_as_notes }) }}
            </small>
            <small v-if="job.preview.complete && job.preview.replace">
              {{ t('profileDataUi.replaceCounts', { current: replaceCurrentTotal(job), incoming: replaceIncomingTotal(job) }) }}
            </small>
            <small v-if="!job.preview.complete">{{ t('profileDataUi.replaceUnavailable') }}</small>
            <small v-if="job.expires_at">{{ t('profileDataUi.preflightExpires', { date: formatDate(job.expires_at) }) }}</small>
          </template>
          <small v-if="['queued', 'running', 'applying', 'rolling_back'].includes(job.status) && job.progress_total">
            {{ job.progress_current }} / {{ job.progress_total }}
          </small>
          <small v-if="job.status === 'completed' && job.mode === 'replace' && job.rollback_expires_at">
            {{ t('profileDataUi.rollbackUntil', { date: formatDate(job.rollback_expires_at) }) }}
          </small>
          <small v-if="job.status === 'completed' && job.mode === 'incremental'">
            {{ t('profileDataUi.incrementalNoRollback') }}
          </small>
          <small v-if="job.status === 'needs_recovery'">{{ t('profileDataUi.needsRecovery') }}</small>
        </div>
        <div class="data-job-actions">
          <template v-if="job.status === 'preview_ready' && !isPreflightExpired(job)">
            <button v-if="importTokens[job.id]" class="pm-save-btn" :disabled="applying || Boolean(job.preview?.conflicts?.total)" @click="applyIncremental(job)">
              {{ applying ? t('profileDataUi.importing') : t('profileDataUi.incrementalImport') }}
            </button>
            <button v-if="importTokens[job.id] && job.preview?.complete" class="pm-danger-btn" :disabled="applying" @click="applyReplace(job)">
              {{ applying ? t('profileDataUi.importing') : t('profileDataUi.replaceCurrent') }}
            </button>
            <button v-if="!importTokens[job.id]" class="pm-style-chip" :disabled="resumingJobs.has(job.id)" @click="resumeImport(job)">
              {{ resumingJobs.has(job.id) ? t('profileDataUi.restoringImport') : t('profileDataUi.resumeImport') }}
            </button>
          </template>
          <button v-if="job.status === 'queued'" class="pm-style-chip" @click="cancelImport(job)">
            {{ t('profileDataUi.cancel') }}
          </button>
          <button v-if="job.status === 'completed' && job.mode === 'replace' && job.rollback_expires_at && new Date(job.rollback_expires_at) > new Date()" class="pm-danger-btn" :disabled="applying" @click="rollbackReplace(job)">
            {{ t('profileDataUi.undoReplace') }}
          </button>
          <button v-if="job.status === 'needs_recovery'" class="pm-style-chip" :disabled="applying" @click="recoverImport(job)">
            {{ t('profileDataUi.recover') }}
          </button>
          <button v-if="['preview_ready', 'failed', 'canceled', 'expired'].includes(job.status)" class="pm-danger-btn" :disabled="deletingImport === job.id" @click="deleteImport(job)">
            {{ deletingImport === job.id ? t('profileDataUi.deletingImport') : t('profileDataUi.deleteImport') }}
          </button>
        </div>
      </article>
    </div>

    <div v-if="!desktop" class="data-jobs">
      <h4>{{ t('profileDataUi.jobs') }}</h4>
      <p v-if="jobs.length === 0 && !loadingJobs" class="data-muted">{{ t('profileDataUi.empty') }}</p>
      <article v-for="job in jobs" :key="job.id" class="data-job">
        <div class="data-job-copy">
          <strong>{{ statusLabel(job.status) }}</strong>
          <small v-if="job.expires_at && job.status === 'ready'">{{ t('profileDataUi.expires', { date: formatDate(job.expires_at) }) }}</small>
          <small v-if="job.status === 'failed'">{{ t('profileDataUi.exportFailed') }}</small>
          <template v-if="['running', 'canceling'].includes(job.status)">
            <small>{{ exportStageLabel(job.stage) }}</small>
            <div
              class="data-job-progress"
              role="progressbar"
              :aria-label="t('profileDataUi.running')"
              :aria-valuetext="exportStageLabel(job.stage)"
            >
              <div class="data-job-progress-fill" />
            </div>
          </template>
        </div>
        <div class="data-job-actions">
          <button v-if="job.download_available" class="pm-save-btn" :disabled="downloading === job.id" @click="download(job)">
            {{ downloading === job.id ? t('common.status.loading') : t('profileDataUi.download') }}
          </button>
          <button v-else-if="['queued', 'running', 'canceling'].includes(job.status)" class="pm-style-chip" :disabled="job.status === 'canceling' || canceling === job.id" @click="cancel(job)">
            {{ job.status === 'canceling' ? t('profileDataUi.canceling') : t('profileDataUi.cancel') }}
          </button>
          <button v-if="!['queued', 'running', 'canceling'].includes(job.status)" class="pm-danger-btn" :disabled="deleting === job.id" @click="deleteExport(job)">
            {{ deleting === job.id ? t('profileDataUi.deleting') : t('profileDataUi.deleteExport') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useLocalPreferencesAccess } from '@/services/localPreferencesAccess'
import { useDesktopProfile } from './desktopProfile'
import { computed, onMounted, onUnmounted, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { dataPortabilityApi, type DataExportJob, type DataImportJob } from '@/services/api'

const props = defineProps({ refreshImportedData: Function as PropType<() => void> })
const { t } = useI18n()
const desktop = useDesktopProfile()
const local = useLocalPreferencesAccess()
const desktopPreflight = ref<{ id: string; added: number; skipped: number; completed?: boolean } | null>(null)
const inventory = ref<Record<string, number> | null>(null)
const preview = ref<Awaited<ReturnType<typeof dataPortabilityApi.preview>> | null>(null)
const jobs = ref<DataExportJob[]>([])
const importJobs = ref<DataImportJob[]>([])
const loading = ref(true)
const loadingJobs = ref(true)
const creating = ref(false)
const canceling = ref('')
const deleting = ref('')
const deletingImport = ref('')
const downloading = ref('')
const selectedArchive = ref<File | null>(null)
const archiveInput = ref<HTMLInputElement | null>(null)
const importTokens = ref<Record<string, string>>({})
const resumingJobs = ref(new Set<string>())
const attemptedResumeJobs = new Set<string>()
const importing = ref(false)
const applying = ref(false)
const error = ref('')
const includeDrafts = ref(!desktop)
const includeImMemory = ref(!desktop)
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

const visibleCategories = computed(() => Object.keys(inventory.value ?? preview.value?.categories ?? {}).filter(key =>
  !['archive_docs', 'drafts', 'im_memory', 'files'].includes(key),
))
const totalBytes = computed(() => Object.entries(preview.value?.categories ?? {})
  .reduce((sum, [key, value]) => key === 'files' ? sum : sum + value.bytes, 0))
onMounted(async () => {
  if (desktop) {
    try {
      if (!local?.dataInventory) throw new Error(t('profileDataUi.previewFailed'))
      inventory.value = await local.dataInventory()
    } catch {
      error.value = t('profileDataUi.previewFailed')
    } finally {
      loading.value = false
    }
    return
  }
  await Promise.all([loadPreview(), loadJobs(), loadImportJobs()])
  pollTimer = setInterval(() => { void loadJobs(); void loadImportJobs() }, 3000)
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })

async function preflightDesktopArchive() {
  if (!local?.preflightBusinessArchive || importing.value || applying.value) return
  importing.value = true
  error.value = ''
  desktopPreflight.value = null
  try {
    desktopPreflight.value = await local.preflightBusinessArchive()
  } catch {
    error.value = t('profileDataUi.desktopPreflightFailed')
  } finally {
    importing.value = false
  }
}

async function exportDesktopArchive() {
  if (!local?.exportBusinessArchive || creating.value) return
  creating.value = true
  error.value = ''
  try {
    await local.exportBusinessArchive()
  } catch {
    error.value = t('profileDataUi.exportFailed')
  } finally {
    creating.value = false
  }
}

async function loadPreview() {
  loading.value = true
  try { preview.value = await dataPortabilityApi.preview() }
  catch { error.value = t('profileDataUi.previewFailed') }
  finally { loading.value = false }
}

async function loadJobs() {
  try {
    const listed = await dataPortabilityApi.listExports()
    jobs.value = listed.map(remote => {
      const current = jobs.value.find(job => job.id === remote.id)
      return current && current.id === canceling.value && current.status === 'canceling' && remote.status === 'running'
        ? current
        : remote
    })
  }
  catch { if (!jobs.value.length) error.value = t('profileDataUi.loadFailed') }
  finally { loadingJobs.value = false }
}

async function loadImportJobs() {
  try {
    importJobs.value = await dataPortabilityApi.listImports()
    for (const job of importJobs.value) {
      if (job.status === 'preview_ready' && !isPreflightExpired(job) && !importTokens.value[job.id] && !attemptedResumeJobs.has(job.id)) {
        attemptedResumeJobs.add(job.id)
        void resumeImport(job)
      }
    }
  }
  catch { /* keep the last visible history while the endpoint is temporarily unavailable */ }
}

async function createExport() {
  if (desktop) return exportDesktopArchive()
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
    const categories = Object.keys(preview.value.categories).filter(key => key !== 'archive_docs' && key !== 'files'
      && (includeDrafts.value || key !== 'drafts') && (includeImMemory.value || key !== 'im_memory'))
    await dataPortabilityApi.createExport(categories, createIdempotencyKey())
    await loadJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.createFailed')
  } finally { creating.value = false }
}

async function cancel(job: DataExportJob) {
  canceling.value = job.id
  error.value = ''
  jobs.value = jobs.value.map(current => current.id === job.id
    ? { ...current, status: 'canceling', stage: 'canceling' }
    : current)
  try {
    const updated = await dataPortabilityApi.cancelExport(job.id)
    jobs.value = jobs.value.map(current => current.id === updated.id ? updated : current)
    await loadJobs()
  }
  catch (cause) {
    canceling.value = ''
    await loadJobs()
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.cancelFailed')
  }
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
      // 用当前页面 origin 下的 API 路径触发原生下载，避免跳到后端监听端口。
      // Ticket 是 HttpOnly Cookie，浏览器会随同源请求发送；文件名由 Content-Disposition 提供。
      const ticketUrl = new URL(url, window.location.origin)
      const downloadUrl = new URL(ticketUrl.pathname + ticketUrl.search, window.location.origin)
      const link = document.createElement('a')
      link.href = downloadUrl.href
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      link.remove()
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
}

async function preflightImport() {
  if (desktop) return preflightDesktopArchive()
  if (!selectedArchive.value || importing.value) return
  importing.value = true
  error.value = ''
  try {
    const result = await dataPortabilityApi.preflightImport(selectedArchive.value)
    if (result.import_token) importTokens.value = { ...importTokens.value, [result.id]: result.import_token }
    upsertImportJob(result)
    selectedArchive.value = null
    if (archiveInput.value) archiveInput.value.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.preflightFailed')
  } finally { importing.value = false }
}

function upsertImportJob(updated: DataImportJob) {
  const index = importJobs.value.findIndex(item => item.id === updated.id)
  if (index < 0) importJobs.value = [updated, ...importJobs.value]
  else importJobs.value = importJobs.value.map(item => item.id === updated.id ? updated : item)
}

async function resumeImport(job: DataImportJob) {
  if (importTokens.value[job.id] || resumingJobs.value.has(job.id)) return
  resumingJobs.value.add(job.id)
  try {
    const resumed = await dataPortabilityApi.resumeImport(job.id)
    if (resumed.import_token) importTokens.value = { ...importTokens.value, [job.id]: resumed.import_token }
    upsertImportJob(resumed)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.resumeImportFailed')
  } finally {
    const next = new Set(resumingJobs.value)
    next.delete(job.id)
    resumingJobs.value = next
  }
}

function plannedImportCounts(job: DataImportJob) {
  return {
    add: (job.preview?.incremental?.add_total ?? 0) + (job.preview?.memory?.add_total ?? 0),
    skip: (job.preview?.incremental?.skip_total ?? 0) + (job.preview?.memory?.skip_total ?? 0),
  }
}
function replaceCurrentTotal(job: DataImportJob) {
  return Object.values(job.preview?.replace?.current ?? {}).reduce((sum, count) => sum + count, 0)
}
function replaceIncomingTotal(job: DataImportJob) {
  return Object.values(job.preview?.replace?.incoming ?? {}).reduce((sum, count) => sum + count, 0)
}
function isPreflightExpired(job: DataImportJob) {
  return job.status === 'preview_ready' && (!job.expires_at || new Date(job.expires_at).getTime() <= Date.now())
}

async function applyReplace(job: DataImportJob) {
  const token = importTokens.value[job.id]
  if (!token || !job.preview?.complete || applying.value) return
  const confirmed = await confirmDialog({
    title: t('profileDataUi.replaceConfirmTitle'),
    message: t('profileDataUi.replaceConfirmMessage', {
      current: replaceCurrentTotal(job),
      incoming: replaceIncomingTotal(job),
    }),
    tone: 'warning',
    confirmText: t('profileDataUi.replaceCurrent'),
  })
  if (!confirmed) return
  applying.value = true
  error.value = ''
  try {
    upsertImportJob(await dataPortabilityApi.applyImport(job.id, 'replace', token, createIdempotencyKey()))
    delete importTokens.value[job.id]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function applyIncremental(job?: DataImportJob) {
  const localJob = desktopPreflight.value
  const applyLocal = local?.applyBusinessArchive
  const webJob = job && { id: job.id, token: importTokens.value[job.id], counts: plannedImportCounts(job) }
  if (applying.value || importing.value) return
  if (desktop ? !localJob || localJob.completed || !applyLocal : !webJob?.token) return
  const counts = desktop && localJob ? { add: localJob.added, skip: localJob.skipped } : webJob?.counts
  const confirmed = await confirmDialog({
    title: t('profileDataUi.incrementalConfirmTitle'),
    message: t('profileDataUi.incrementalConfirmMessage', counts ?? {}),
    tone: 'warning',
    confirmText: t('profileDataUi.incrementalImport'),
  })
  if (!confirmed || applying.value || (desktop && desktopPreflight.value !== localJob)) return
  applying.value = true
  error.value = ''
  try {
    if (desktop && localJob && applyLocal) {
      const result = await applyLocal(localJob.id)
      desktopPreflight.value = { ...localJob, ...result, completed: true }
      if (result.added > 0) props.refreshImportedData?.()
      if (local?.dataInventory) {
        try { inventory.value = await local.dataInventory() }
        catch { error.value = t('profileDataUi.previewFailed') }
      }
    } else if (webJob?.token) {
      upsertImportJob(await dataPortabilityApi.applyImport(webJob.id, 'incremental', webJob.token, createIdempotencyKey()))
      delete importTokens.value[webJob.id]
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function cancelImport(job: DataImportJob) {
  try { upsertImportJob(await dataPortabilityApi.cancelImport(job.id)); delete importTokens.value[job.id] }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('profileDataUi.cancelFailed') }
}

async function deleteImport(job: DataImportJob) {
  const confirmed = await confirmDialog({
    title: t('profileDataUi.deleteImportConfirmTitle'),
    message: t('profileDataUi.deleteImportConfirmMessage'),
    tone: 'warning',
    confirmText: t('profileDataUi.deleteImport'),
  })
  if (!confirmed) return
  deletingImport.value = job.id
  error.value = ''
  try {
    await dataPortabilityApi.deleteImport(job.id)
    delete importTokens.value[job.id]
    attemptedResumeJobs.delete(job.id)
    importJobs.value = importJobs.value.filter(current => current.id !== job.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.deleteImportFailed')
  } finally { deletingImport.value = '' }
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
    upsertImportJob(await dataPortabilityApi.rollbackImport(job.id, createIdempotencyKey()))
    await loadImportJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

async function recoverImport(job: DataImportJob) {
  applying.value = true
  error.value = ''
  try {
    upsertImportJob(await dataPortabilityApi.recoverImport(job.id))
    await loadImportJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('profileDataUi.importFailed')
  } finally { applying.value = false }
}

function statusLabel(status: string) {
  const key = ['queued', 'running', 'canceling', 'ready', 'failed', 'canceled', 'expired'].includes(status) ? status : 'unknown'
  return t(`profileDataUi.${key}`)
}
function exportStageLabel(stage: string | null) {
  const key = stage === 'storing' ? 'exportStage_storing' : stage === 'projecting' ? 'exportStage_projecting' : 'exportStage_running'
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
.data-intro, .data-muted, .data-warning { margin: 0; color: var(--content-secondary); font-size: 13px; line-height: 1.55; }
.data-muted { color: var(--content-tertiary); }
.data-warning { color: var(--warning-text, var(--content-secondary)); }
.data-conflict { color: var(--pm-danger-text, #a44949) !important; }
.data-summary { border: 1px solid var(--subpanel-border); background: var(--subpanel-bg); border-radius: var(--radius-sm); padding: 12px 14px; }
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
.data-job-progress { width: min(240px, 100%); height: var(--progress-track-height); overflow: hidden; border-radius: var(--progress-track-radius); background: var(--progress-track-bg); }
.data-job-progress-fill { width: 38%; height: 100%; border-radius: inherit; background: var(--progress-fill-bg); animation: data-job-progress-indeterminate 1.4s ease-in-out infinite alternate; }
@keyframes data-job-progress-indeterminate {
  from { transform: translateX(-110%); }
  to { transform: translateX(263%); }
}
.data-job-actions { display: flex; gap: 8px; }
@media (prefers-reduced-motion: reduce) {
  .data-job-progress-fill { animation: none; transform: translateX(82%); }
}
</style>
