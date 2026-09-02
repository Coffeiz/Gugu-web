<template>
  <BaseModal :show="show" width="520px" background="var(--file-dialog-modal-bg)" @close="handleClose">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ t('filesUi.uploadTitle') }}</h2>
          <CloseButton @click="handleClose" />
        </div>

        <div class="modal-body">
          <div
            v-if="!uploading"
            class="drop-zone"
            :class="{ dragging: isDragging, 'has-files': pendingFiles.length > 0 }"
            @dragenter.prevent="dragCounter++; isDragging = true"
            @dragover.prevent
            @dragleave.prevent="dragCounter--; if (dragCounter === 0) isDragging = false"
            @drop.prevent="dragCounter = 0; isDragging = false; handleDrop($event)"
            @click="pendingFiles.length === 0 && fileInputRef?.click()"
          >
            <input type="file" ref="fileInputRef" multiple hidden @change="handleFileInput" />

            <template v-if="pendingFiles.length === 0">
              <svg class="dz-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" :class="{ pulse: isDragging }">
                <path d="M18 24V14M13 18l5-5 5 5"/>
                <path d="M6 28h24"/>
              </svg>
              <span class="dz-title">
                {{ t('filesUi.dropOr') }}
                <span class="dz-link" @click.stop="fileInputRef?.click()">{{ t('filesUi.choose') }}</span>
              </span>
              <span class="dz-sub">{{ t('filesUi.supported') }}</span>
            </template>

            <template v-else>
              <div class="file-stack" @click.stop>
                <div v-for="(f, i) in pendingFiles" :key="pendingPaths[i] + i" class="file-row">
                  <span class="file-ext">{{ f.name.split('.').pop().toUpperCase().slice(0, 4) }}</span>
                  <span class="file-name" :title="pendingPaths[i]">{{ pendingPaths[i] }}</span>
                  <span class="file-size">{{ fmtSize(f.size) }}</span>
                  <button class="file-remove" @click="removeFile(i)" :title="t('filesUi.remove')">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M2 2l8 8M10 2L2 10"/>
                    </svg>
                  </button>
                </div>
              </div>
              <button class="add-more-btn" @click.stop="fileInputRef?.click()">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 1v10M1 6h10"/>
                </svg>
                {{ t('filesUi.addMore') }}
              </button>
            </template>
          </div>

          <div v-else class="upload-progress">
            <div v-for="(f, i) in pendingFiles" :key="pendingPaths[i] + i" class="up-file-row">
              <div class="up-fill" :class="{ done: fileProgresses[i] >= 1 }" :style="{ width: (fileProgresses[i] * 100) + '%' }"></div>
              <span class="file-ext">{{ f.name.split('.').pop().toUpperCase().slice(0, 4) }}</span>
              <span class="up-file-name" :title="pendingPaths[i]">{{ pendingPaths[i] }}</span>
              <span class="up-status">
                <svg v-if="fileProgresses[i] >= 1" class="up-done-icon" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <path d="M2 7l3.5 3.5L12 3"/>
                </svg>
                <span v-else-if="i === uploadedCount" class="up-spinner"></span>
              </span>
            </div>
          </div>

          <div class="field project-field" v-if="!lockedProjectId">
            <label>
              {{ t('filesUi.putInProject') }}
              <span class="label-hint">{{ t('filesUi.optional') }}</span>
            </label>

            <div class="proj-list scroll-surface scroll-surface--compact">
              <button class="select-btn" :class="{ active: selectedId === null }" @click="selectedId = null">{{ t('filesUi.unlinked') }}</button>

              <template v-if="pendingProjects.length">
                <div class="status-label"><span class="status-dot status-pending"></span>{{ t('filesUi.pending') }}</div>
                <div class="proj-group-chips">
                  <button v-for="p in pendingProjects" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                    <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                  </button>
                </div>
              </template>

              <template v-if="activeProjects.length">
                <div class="status-label"><span class="status-dot status-active"></span>{{ t('filesUi.active') }}</div>
                <div class="proj-group-chips">
                  <button v-for="p in activeProjects" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                    <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                  </button>
                </div>
              </template>

              <template v-if="doneProjects.length">
                <button class="status-toggle" @click="doneExpanded = !doneExpanded">
                  <svg class="toggle-chev" :class="{ open: doneExpanded }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M2 3.5l3 3 3-3"/>
                  </svg>
                  <span class="status-dot status-done"></span>{{ t('filesUi.done') }}
                  <span class="status-cnt">{{ doneProjects.length }}</span>
                </button>
                <div v-show="doneExpanded" class="done-tree">
                  <div v-for="yg in groupedDone" :key="yg.year" class="year-group">
                    <button class="year-row" @click="toggleYear(yg.year)">
                      <svg class="year-chev" :class="{ open: openYears.has(yg.year) }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M2 3.5l3 3 3-3"/>
                      </svg>
                      <span class="year-label">{{ yg.year }}</span>
                      <span class="status-cnt">{{ yg.total }}</span>
                    </button>
                    <div v-show="openYears.has(yg.year)" class="year-body">
                      <div v-for="mg in yg.months" :key="mg.month" class="month-group">
                        <button class="month-row" @click="toggleMonth(yg.year + mg.month)">
                          <svg class="month-folder" :class="{ open: openMonths.has(yg.year + mg.month) }" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1.5 6a1.5 1.5 0 011.5-1.5H5.5l1.5 2H13a1.5 1.5 0 011.5 1.5V13A1.5 1.5 0 0113 14.5H3A1.5 1.5 0 011.5 13V6z"/>
                          </svg>
                          <span class="month-name">{{ mg.month }}</span>
                          <span class="status-cnt">{{ mg.items.length }}</span>
                          <svg class="month-chev" :class="{ open: openMonths.has(yg.year + mg.month) }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                            <path d="M2 3.5l3 3 3-3"/>
                          </svg>
                        </button>
                        <div v-show="openMonths.has(yg.year + mg.month)" class="month-chips">
                          <button v-for="p in mg.items" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                            <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="undatedDone.length" class="year-group">
                    <button class="year-row" @click="toggleYear('__undated')">
                      <svg class="year-chev" :class="{ open: openYears.has('__undated') }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M2 3.5l3 3 3-3"/>
                      </svg>
                      <span class="year-label undated">{{ t('filesUi.undated') }}</span>
                      <span class="status-cnt">{{ undatedDone.length }}</span>
                    </button>
                    <div v-show="openYears.has('__undated')" class="month-chips undated-chips">
                      <button v-for="p in undatedDone" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                        <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                      </button>
                    </div>
                  </div>
                </div>
              </template>

              <span v-if="projects.length === 0" class="no-proj-hint">{{ t('filesUi.noProjects') }}</span>
            </div>
          </div>
          <div class="field locked-hint" v-else>
            <label>{{ t('filesUi.uploadLocation') }}</label>
            <span class="locked-tag">
              <span class="p-dot" :style="{ background: lockedColor }"></span>
              {{ lockedProjectName }}
            </span>
          </div>

          <div class="field" v-if="effectiveProjectId && lockedFolderId === null">
            <label>
              {{ t('filesUi.putInFolder') }}
              <span class="label-hint">{{ t('filesUi.optional') }}</span>
            </label>
            <div v-if="projectFolders.length" class="proj-group-chips">
              <button class="select-btn" :class="{ active: selectedFolderId === null }" @click="selectedFolderId = null">{{ t('filesUi.root') }}</button>
              <button v-for="f in projectFolders" :key="f.id" class="select-btn" :class="{ active: selectedFolderId === f.id }" @click="selectedFolderId = f.id">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M1 3.5a1 1 0 011-1h2l1 1.5h5a1 1 0 011 1V9a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z"/>
                </svg>
                {{ f.name }}
              </button>
            </div>
            <span v-else class="no-proj-hint">{{ t('filesUi.noFolders') }}</span>
          </div>
          <div class="field locked-hint" v-else-if="lockedFolderId !== null">
            <label>{{ t('filesUi.currentFolder') }}</label>
            <span class="locked-tag">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M1 3.5a1 1 0 011-1h2l1 1.5h5a1 1 0 011 1V9a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z"/>
              </svg>
              {{ projectFolders.find(f => f.id === lockedFolderId)?.name ?? t('filesUi.currentFolder') }}
            </span>
          </div>

          <div class="field" v-if="effectiveProjectId && currentProjectStages.length">
            <label>
              {{ t('filesUi.stage') }}
              <span class="label-hint">{{ t('filesUi.optional') }}</span>
            </label>
            <div class="proj-group-chips">
              <button class="select-btn" :class="{ active: selectedStage === '' }" @click="selectedStage = ''">{{ t('filesUi.unmarked') }}</button>
              <button v-for="s in currentProjectStages" :key="s.key" class="select-btn stage-tag-btn" :class="{ active: selectedStage === s.label }" @click="selectedStage = s.label">{{ s.label }}</button>
            </div>
          </div>
        </div>

        <div v-if="!uploading" class="modal-footer">
          <button class="btn-cancel" @click="handleClose">{{ t('filesUi.cancel') }}</button>
          <button class="btn-upload" :disabled="pendingFiles.length === 0 || uploading" @click="handleUpload">
            {{ uploading ? `${t('filesUi.uploading')} (${uploadedCount}/${pendingFiles.length})` : t('filesUi.confirmUpload') }}
          </button>
        </div>
      </div>
  </BaseModal>
</template>

<script setup lang="ts">
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import { ref, computed, watch, type PropType } from 'vue'
import { uploadWithProgress, uploadDirectWithProgress, filesApi, foldersApi } from '@/services/api'
import { readDroppedEntries, filesToItems, resolveFolderTree } from '@/composables/files/useFileUploadCore'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  show:              Boolean,
  projects:          { type: Array as PropType<any[]>, default: () => [] },
  lockedProjectId:   { type: Number, default: null },
  lockedProjectName: { type: String, default: '' },
  lockedColor:       { type: String, default: '' },
  lockedFolderId:    { type: Number, default: null },
  initialFiles:      { type: Array as PropType<File[]>, default: () => [] },
})
const emit = defineEmits(['close', 'uploaded'])

const fileInputRef    = ref<HTMLInputElement | null>(null)
const pendingFiles    = ref<any[]>([])
const pendingPaths    = ref<any[]>([])
const selectedId      = ref<number | string | null>(null)
const selectedFolderId = ref<number | string | null>(null)
const selectedStage   = ref('')
const isDragging      = ref(false)
const fileProgresses  = ref<any[]>([])
let   dragCounter     = 0
const uploading       = ref(false)
const uploadedCount   = ref(0)
const doneExpanded    = ref(false)
const openYears       = ref(new Set())
const openMonths      = ref(new Set())
const projectFolders  = ref<any[]>([])

const effectiveProjectId = computed(() => props.lockedProjectId ?? selectedId.value)
const currentProjectStages = computed(() => {
  if (!effectiveProjectId.value) return []
  const proj = props.projects.find(p => p.id === effectiveProjectId.value)
  return proj?.stages ?? []
})

function stageDefault(pid = effectiveProjectId.value) {
  if (!pid) return ''
  const proj = props.projects.find(p => p.id === pid)
  const cur = proj?.stages?.find((s: any) => s.key === proj.currentStage)
  return cur?.label ?? ''
}

async function loadFolders(pid: any) {
  if (!pid) { projectFolders.value = []; return }
  try { projectFolders.value = await foldersApi.list(pid) }
  catch { projectFolders.value = [] }
}

watch(effectiveProjectId, (pid) => {
  selectedFolderId.value = null
  selectedStage.value = stageDefault(pid)
  loadFolders(pid)
}, { immediate: false })
watch(selectedId, () => { selectedFolderId.value = null })
watch(() => props.show, v => {
  if (v) {
    if (props.initialFiles.length) addFiles(filesToItems(props.initialFiles))
    if (effectiveProjectId.value) loadFolders(effectiveProjectId.value)
    selectedStage.value = stageDefault()
  } else {
    pendingFiles.value = []
    pendingPaths.value = []
    selectedId.value = null
    selectedFolderId.value = null
    selectedStage.value = ''
    isDragging.value = false
    dragCounter = 0
    uploading.value = false
    uploadedCount.value = 0
    doneExpanded.value = false
    projectFolders.value = []
  }
})

const pendingProjects = computed(() => props.projects.filter(p => p.status === 'pending'))
const activeProjects  = computed(() => props.projects.filter(p => p.status === 'active'))
const doneProjects    = computed(() => props.projects.filter(p => p.status === 'done'))

function dateOf(p: any) {
  const src = p.startDate || p.deadline || p.doneAt || null
  if (!src) return null
  return new Date(src.length === 10 ? src + 'T00:00:00' : src)
}
const undatedDone = computed(() => doneProjects.value.filter(p => !dateOf(p)))
const groupedDone = computed(() => {
  const yearMap = new Map()
  for (const p of doneProjects.value) {
    const d = dateOf(p)
    if (!d) continue
    const y = String(d.getFullYear())
    const m = String(d.getMonth() + 1).padStart(2, '0') + '月'
    if (!yearMap.has(y)) yearMap.set(y, new Map())
    const mMap = yearMap.get(y)
    if (!mMap.has(m)) mMap.set(m, [])
    mMap.get(m).push(p)
  }
  return [...yearMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, mMap]) => ({
      year,
      total: [...mMap.values()].reduce((s, arr) => s + arr.length, 0),
      months: [...mMap.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, items]) => ({ month, items })),
    }))
})

function toggleYear(y: string) {
  const next = new Set(openYears.value)
  next.has(y) ? next.delete(y) : next.add(y)
  openYears.value = next
}
function toggleMonth(key: string) {
  const next = new Set(openMonths.value)
  next.has(key) ? next.delete(key) : next.add(key)
  openMonths.value = next
}
function fmtSize(bytes: number) {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}
function extractColor(colorStr: string) {
  const m = colorStr?.match(/#[0-9a-fA-F]{3,6}/)
  return m ? m[0] : '#8a8fa8'
}
function handleFileInput(e: Event) {
  const inp = e.target as HTMLInputElement
  if (inp.files) addFiles(filesToItems(inp.files))
  inp.value = ''
}
async function handleDrop(e: DragEvent) {
  if (e.dataTransfer) addFiles(await readDroppedEntries(e.dataTransfer))
}
function addFiles(items: any) {
  const existing = new Set(pendingPaths.value.map((p, i) => p + ':' + pendingFiles.value[i].size))
  for (const { file, relativePath } of items) {
    const key = relativePath + ':' + file.size
    if (!existing.has(key)) {
      existing.add(key)
      pendingFiles.value.push(file)
      pendingPaths.value.push(relativePath)
    }
  }
}
function removeFile(i: number) {
  pendingFiles.value.splice(i, 1)
  pendingPaths.value.splice(i, 1)
}
function handleClose() {
  if (uploading.value) return
  emit('close')
}

async function handleUpload() {
  if (pendingFiles.value.length === 0 || uploading.value) return
  uploading.value = true
  uploadedCount.value = 0
  fileProgresses.value = pendingFiles.value.map(() => 0)

  const projectId = effectiveProjectId.value as number
  const baseFolderId = (props.lockedFolderId !== null ? props.lockedFolderId : selectedFolderId.value) as number | null
  const space = projectId ? 'project' : 'personal'
  const uploaded: any[] = []

  try {
    const items = pendingFiles.value.map((file, i) => ({ file, relativePath: pendingPaths.value[i] }))
    const resolved = await resolveFolderTree(items, { projectId, baseFolderId })

    for (let i = 0; i < pendingFiles.value.length; i++) {
      const f = pendingFiles.value[i]
      const folderId = resolved[i].folderId
      const presign = await filesApi.presign({
        filename: f.name,
        size_bytes: f.size,
        mime_type: f.type || 'application/octet-stream',
        space,
        project_id: projectId ?? null,
        folder_id: folderId ?? null,
        stage_name: selectedStage.value,
      })

      let created
      if (presign.mode === 'oss') {
        await uploadDirectWithProgress(presign.upload_url, f, (pct) => {
          const next = [...fileProgresses.value]
          next[i] = pct * 0.95
          fileProgresses.value = next
        })
        created = await filesApi.confirm({
          storage_key: presign.storage_key,
          display_name: presign.final_name,
          ext: presign.ext,
          mime_type: f.type || 'application/octet-stream',
          size_bytes: f.size,
          space,
          project_id: projectId ?? null,
          folder_id: folderId ?? null,
          stage_name: selectedStage.value,
        })
      } else {
        const form = new FormData()
        form.append('file', f)
        form.append('space', space)
        if (projectId != null) form.append('project_id', String(projectId))
        if (folderId != null) form.append('folder_id', String(folderId))
        form.append('stage_name', selectedStage.value)
        created = await uploadWithProgress('/files', form, (pct) => {
          const next = [...fileProgresses.value]
          next[i] = pct
          fileProgresses.value = next
        })
      }
      fileProgresses.value[i] = 1
      uploaded.push(created)
      uploadedCount.value++
    }
    emit('uploaded', uploaded)
    setTimeout(() => emit('close'), 500)
  } catch (err) {
    console.error('[UploadModal] 上传失败:', err)
    uploading.value = false
  }
}
</script>

<style scoped>
.modal { display: contents; color: var(--content-primary); }
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px 16px; border-bottom: 1px solid var(--file-dialog-divider); flex-shrink: 0;
}
.modal-header h2 { font-size: 16px; font-weight: 700; color: var(--content-primary); }
.modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 18px; }

.drop-zone {
  min-height: 148px; padding: 20px; border-radius: var(--radius-md);
  border: 1.5px dashed var(--file-dialog-drop-border); background: var(--file-dialog-drop-bg);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: pointer;
  transition: border-color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.drop-zone:hover:not(.has-files) { border-color: var(--file-dialog-drop-border-hover); background: var(--file-dialog-drop-bg-hover); }
.drop-zone.dragging { border-color: var(--action-primary); border-style: solid; background: var(--file-dialog-drop-bg-active); }
.drop-zone.has-files { cursor: default; align-items: stretch; justify-content: flex-start; gap: 6px; max-height: 320px; overflow-y: auto; }
.dz-icon { color: var(--content-secondary); opacity: .5; }
.dz-icon.pulse { opacity: .8; color: var(--action-primary); }
.dz-title { font-size: 13px; font-weight: 500; color: var(--content-secondary); }
.dz-link { color: var(--action-primary); font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.dz-sub { font-size: 11px; color: var(--content-tertiary); }

.file-stack, .upload-progress { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.file-row, .up-file-row {
  display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--file-dialog-item-bg); border: 1px solid var(--file-dialog-item-border); box-shadow: var(--file-dialog-item-shadow);
}
.up-file-row { position: relative; overflow: hidden; }
.file-ext {
  font-size: 9px; font-weight: 800; letter-spacing: .04em; color: var(--action-primary);
  background: var(--action-soft); border-radius: var(--radius-xs); padding: 2px 6px; flex-shrink: 0;
}
.file-name, .up-file-name {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: var(--content-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; margin-bottom: -2px;
}
.up-file-name { position: relative; }
.file-size { font-size: 11px; color: var(--content-secondary); flex-shrink: 0; }
.file-remove {
  width: 20px; height: 20px; border-radius: var(--radius-xs); flex-shrink: 0;
  background: none; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--content-tertiary); opacity: .55;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.file-remove:hover { background: var(--danger-button-bg); color: var(--danger-button-fg); opacity: 1; }
.add-more-btn {
  display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; padding: 7px;
  border: 1.5px dashed var(--file-dialog-drop-border); border-radius: var(--radius-sm); background: transparent;
  font: 600 11px var(--font-sans); color: var(--content-secondary); cursor: pointer; flex-shrink: 0;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.add-more-btn:hover { background: var(--file-dialog-drop-bg-hover); border-color: var(--file-dialog-drop-border-hover); color: var(--action-primary); }

.field { display: flex; flex-direction: column; gap: 7px; }
.project-field { flex: 1; min-height: 0; }
label {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 600; color: var(--content-secondary); text-transform: uppercase; letter-spacing: .07em;
}
.label-hint { font-size: 10px; font-weight: 400; color: var(--content-tertiary); text-transform: none; letter-spacing: 0; }
.proj-list {
  display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 6px; overflow-y: auto;
  max-height: none; padding-right: 6px;
  /* OverlayScrollbar uses `right = host inset - offset`, so positive 4px moves the thumb outward
     to the right, away from the project pills. */
  --scrollbar-overlay-right-offset: 4px;
}
.status-label {
  display: flex; align-items: center; gap: 5px; padding: 2px 2px 0;
  font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--content-tertiary); text-transform: uppercase;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.status-pending { background: var(--status-danger); }
.status-active { background: var(--status-warning); }
.status-done { background: var(--status-success); }
.proj-group-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.status-toggle, .year-row, .month-row {
  display: flex; align-items: center; gap: 6px; width: 100%; border: none; background: transparent;
  color: var(--content-secondary); cursor: pointer; font-family: var(--font-sans); text-align: left;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.status-toggle { padding: 4px 6px; border-radius: var(--radius-xs); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.year-row { padding: 3px 6px; border-radius: var(--radius-xs); }
.month-row { padding: 3px 8px; border-radius: var(--radius-xs); }
.status-toggle:hover, .year-row:hover, .month-row:hover { background: var(--surface-soft-hover); color: var(--content-primary); }
.status-cnt { font-size: 10px; color: var(--content-tertiary); font-weight: 400; letter-spacing: 0; text-transform: none; }
.toggle-chev, .year-chev, .month-chev { color: var(--content-tertiary); flex-shrink: 0; transform:rotate(-90deg); transition: transform var(--motion-hover-control) var(--motion-ease-emphasis); }
.toggle-chev.open, .year-chev.open, .month-chev.open { transform: rotate(0deg); }
.done-tree { display: flex; flex-direction: column; gap: 1px; padding-left: 4px; }
.year-group { margin-bottom: 2px; }
.year-label { font-size: 12px; font-weight: 700; color: var(--content-secondary); flex: 1; letter-spacing: .03em; }
.year-label.undated { color: var(--content-tertiary); }
.year-body { padding: 2px 0 2px 6px; border-left: 1px solid var(--file-dialog-divider); margin-left: 6px; margin-top: 1px; }
.month-group { margin-bottom: 1px; }
.month-name { font-size: 11px; font-weight: 500; color: var(--content-secondary); flex: 1; }
.month-folder { color: var(--content-tertiary); transition: color var(--motion-hover-control) var(--motion-ease-standard); }
.month-folder.open { color: var(--status-success); }
.month-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 4px 4px 4px 8px; }
.undated-chips { padding-left: 14px; }
.select-btn {
  display: flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: var(--choice-chip-radius);
  border: 1px solid var(--file-dialog-choice-border); background: var(--file-dialog-choice-bg); color: var(--choice-chip-fg);
  font: 12px var(--font-sans); cursor: pointer; white-space: nowrap;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.select-btn:hover { background: var(--file-dialog-choice-bg-hover); border-color: var(--choice-chip-border-hover); color: var(--choice-chip-fg-hover); }
.select-btn.active {
  background: var(--file-dialog-choice-bg-active); border-color: var(--file-dialog-choice-border-active); color: var(--file-dialog-choice-fg-active);
  box-shadow: var(--file-dialog-choice-shadow-active); font-weight: 600;
}
.p-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; opacity: .85; }
.no-proj-hint { font-size: 11px; color: var(--content-tertiary); }
.locked-hint label { margin-bottom: 4px; }
.locked-tag {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: var(--choice-chip-radius);
  background: var(--choice-chip-bg-active); border: 1px solid var(--choice-chip-border-active);
  font-size: 12px; font-weight: 500; color: var(--choice-chip-fg-active);
}

.up-fill { position: absolute; inset: 0; right: auto; background: var(--selection-bg); transition: width var(--motion-hover-card) var(--motion-ease-standard); pointer-events: none; }
.up-fill.done { background: var(--status-success-bg); }
.up-status { width: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; position: relative; }
.up-done-icon { color: var(--status-success); }
.up-spinner { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--file-dialog-drop-border); border-top-color: var(--action-primary); animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 24px; border-top: 1px solid var(--file-dialog-divider); flex-shrink: 0; }
.btn-cancel {
  padding: 8px 18px; border-radius: var(--radius-sm); border: 1px solid var(--file-dialog-control-border);
  background: var(--file-dialog-control-bg); color: var(--control-fg); font: 13px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.btn-cancel:hover { background: var(--file-dialog-control-bg-hover); border-color: var(--control-border-hover); color: var(--control-fg-strong); }
.btn-upload {
  padding: 8px 22px; border-radius: var(--radius-sm); border: none;
  background: var(--action-primary-bg); color: var(--content-on-accent); box-shadow: none;
  font: 600 13px var(--font-sans); cursor: pointer;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.btn-upload:hover:not(:disabled) { opacity: .9; box-shadow: none; }
.btn-upload:disabled { opacity: .45; cursor: not-allowed; }
</style>
