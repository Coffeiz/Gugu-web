<template>
  <BaseModal :show="show" width="520px" @close="handleClose">
      <div class="modal">
        <!-- 头部 -->
        <div class="modal-header">
          <h2>上传文件</h2>
          <button class="close-btn" @click="handleClose">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

        <!-- 内容 -->
        <div class="modal-body">

          <!-- 拖拽 / 文件选择区 -->
          <div
            v-if="!uploading"
            class="drop-zone"
            :class="{ dragging: isDragging, 'has-files': pendingFiles.length > 0 }"
            @dragenter.prevent="dragCounter++; isDragging = true"
            @dragover.prevent
            @dragleave.prevent="dragCounter--; if (dragCounter === 0) isDragging = false"
            @drop.prevent="dragCounter = 0; isDragging = false; handleDrop($event)"
            @click="pendingFiles.length === 0 && fileInputRef.click()"
          >
            <input type="file" ref="fileInputRef" multiple hidden @change="handleFileInput" />

            <!-- 空状态：图标 + 提示 -->
            <template v-if="pendingFiles.length === 0">
              <svg class="dz-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" :class="{ pulse: isDragging }">
                <path d="M18 24V14M13 18l5-5 5 5"/>
                <path d="M6 28h24"/>
              </svg>
              <span class="dz-title">
                拖入文件，或
                <span class="dz-link" @click.stop="fileInputRef.click()">点击选择</span>
              </span>
              <span class="dz-sub">支持 PSD · PDF · ZIP · PNG 等任意格式</span>
            </template>

            <!-- 有文件：列表 + 继续添加 -->
            <template v-else>
              <div class="file-stack" @click.stop>
                <div v-for="(f, i) in pendingFiles" :key="f.name + i" class="file-row">
                  <span class="file-ext">{{ f.name.split('.').pop().toUpperCase().slice(0, 4) }}</span>
                  <span class="file-name">{{ f.name }}</span>
                  <span class="file-size">{{ fmtSize(f.size) }}</span>
                  <button class="file-remove" @click="removeFile(i)" title="移除">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M2 2l8 8M10 2L2 10"/>
                    </svg>
                  </button>
                </div>
              </div>
              <button class="add-more-btn" @click.stop="fileInputRef.click()">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 1v10M1 6h10"/>
                </svg>
                继续添加文件
              </button>
            </template>
          </div>

          <!-- 上传进度 -->
          <div v-else class="upload-progress">
            <div v-for="(f, i) in pendingFiles" :key="f.name + i" class="up-file-row">
              <!-- 进度背景层 -->
              <div class="up-fill" :class="{ done: fileProgresses[i] >= 1 }" :style="{ width: (fileProgresses[i] * 100) + '%' }"></div>
              <!-- 内容层 -->
              <span class="file-ext">{{ f.name.split('.').pop().toUpperCase().slice(0, 4) }}</span>
              <span class="up-file-name">{{ f.name }}</span>
              <span class="up-status">
                <svg v-if="fileProgresses[i] >= 1" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#5a9e88" stroke-width="2.2" stroke-linecap="round">
                  <path d="M2 7l3.5 3.5L12 3"/>
                </svg>
                <span v-else-if="i === uploadedCount" class="up-spinner"></span>
              </span>
            </div>
          </div>

          <!-- 项目选择（进入项目时锁定，不可更改） -->
          <div class="field" v-if="!lockedProjectId">
            <label>
              放入项目
              <span class="label-hint">选填</span>
            </label>

            <div class="proj-list">
              <!-- 不关联 -->
              <button class="select-btn" :class="{ active: selectedId === null }" @click="selectedId = null">不关联</button>

              <!-- 待开始 -->
              <template v-if="pendingProjects.length">
                <div class="status-label"><span class="status-dot" style="background:#d46b6b"></span>待开始</div>
                <div class="proj-group-chips">
                  <button v-for="p in pendingProjects" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                    <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                  </button>
                </div>
              </template>

              <!-- 进行中 -->
              <template v-if="activeProjects.length">
                <div class="status-label"><span class="status-dot" style="background:#c9943a"></span>进行中</div>
                <div class="proj-group-chips">
                  <button v-for="p in activeProjects" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                    <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                  </button>
                </div>
              </template>

              <!-- 已完成 -->
              <template v-if="doneProjects.length">
                <button class="status-toggle" @click="doneExpanded = !doneExpanded">
                  <svg class="toggle-chev" :class="{ open: doneExpanded }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M2 3.5l3 3 3-3"/>
                  </svg>
                  <span class="status-dot" style="background:#5a9e88"></span>已完成
                  <span class="status-cnt">{{ doneProjects.length }}</span>
                </button>
                <div v-show="doneExpanded" class="done-tree">
                  <!-- 按年/月折叠 -->
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
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" :stroke="openMonths.has(yg.year + mg.month) ? '#5a9e88' : 'currentColor'">
                            <path d="M1.5 6a1.5 1.5 0 011.5-1.5H5.5l1.5 2H13a1.5 1.5 0 011.5 1.5V13A1.5 1.5 0 0113 14.5H3A1.5 1.5 0 011.5 13V6z" :fill="openMonths.has(yg.year + mg.month) ? 'rgba(90,158,136,0.13)' : 'none'"/>
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
                  <!-- 未设置日期 -->
                  <div v-if="undatedDone.length" class="year-group">
                    <button class="year-row" @click="toggleYear('__undated')">
                      <svg class="year-chev" :class="{ open: openYears.has('__undated') }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M2 3.5l3 3 3-3"/>
                      </svg>
                      <span class="year-label" style="opacity:0.5">未设置日期</span>
                      <span class="status-cnt">{{ undatedDone.length }}</span>
                    </button>
                    <div v-show="openYears.has('__undated')" class="month-chips" style="padding-left:14px">
                      <button v-for="p in undatedDone" :key="p.id" class="select-btn" :class="{ active: selectedId === p.id }" @click="selectedId = p.id">
                        <span class="p-dot" :style="{ background: extractColor(p.color) }"></span>{{ p.name }}
                      </button>
                    </div>
                  </div>
                </div>
              </template>

              <span v-if="projects.length === 0" class="no-proj-hint">暂无项目，将以未分类形式上传</span>
            </div>
          </div>
          <div class="field locked-hint" v-else>
            <label>上传位置</label>
            <span class="locked-tag">
              <span class="p-dot" :style="{ background: lockedColor }"></span>
              {{ lockedProjectName }}
            </span>
          </div>

          <!-- 文件夹选择（选了项目且文件夹未锁定时显示） -->
          <div class="field" v-if="effectiveProjectId && lockedFolderId === null">
            <label>
              放入文件夹
              <span class="label-hint">选填</span>
            </label>
            <div v-if="projectFolders.length" class="proj-group-chips">
              <button
                class="select-btn"
                :class="{ active: selectedFolderId === null }"
                @click="selectedFolderId = null"
              >项目根目录</button>
              <button
                v-for="f in projectFolders"
                :key="f.id"
                class="select-btn"
                :class="{ active: selectedFolderId === f.id }"
                @click="selectedFolderId = f.id"
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M1 3.5a1 1 0 011-1h2l1 1.5h5a1 1 0 011 1V9a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z"/>
                </svg>
                {{ f.name }}
              </button>
            </div>
            <span v-else class="no-proj-hint">暂无文件夹，文件将放在项目根目录</span>
          </div>
          <div class="field locked-hint" v-else-if="lockedFolderId !== null">
            <label>文件夹</label>
            <span class="locked-tag">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M1 3.5a1 1 0 011-1h2l1 1.5h5a1 1 0 011 1V9a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z"/>
              </svg>
              {{ projectFolders.find(f => f.id === lockedFolderId)?.name ?? '当前文件夹' }}
            </span>
          </div>

          <!-- 阶段标签（选了项目时显示，纯可选） -->
          <div class="field" v-if="effectiveProjectId && currentProjectStages.length">
            <label>
              阶段标签
              <span class="label-hint">选填</span>
            </label>
            <div class="proj-group-chips">
              <button
                class="select-btn"
                :class="{ active: selectedStage === '' }"
                @click="selectedStage = ''"
              >不标记</button>
              <button
                v-for="s in currentProjectStages"
                :key="s.key"
                class="select-btn stage-tag-btn"
                :class="{ active: selectedStage === s.label }"
                @click="selectedStage = s.label"
              >{{ s.label }}</button>
            </div>
          </div>

        </div>

        <!-- 底部 -->
        <div v-if="!uploading" class="modal-footer">
          <button class="btn-cancel" @click="handleClose">取消</button>
          <button
            class="btn-upload"
            :disabled="pendingFiles.length === 0 || uploading"
            @click="handleUpload"
          >
            {{ uploading ? `上传中… (${uploadedCount}/${pendingFiles.length})` : '确认上传' }}
          </button>
        </div>
      </div>
  </BaseModal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { uploadWithProgress, uploadDirectWithProgress, filesApi, foldersApi } from '@/services/api'
import BaseModal from '@/components/common/BaseModal.vue'

const props = defineProps({
  show:              Boolean,
  projects:          { type: Array,  default: () => [] },
  lockedProjectId:   { type: Number, default: null },
  lockedProjectName: { type: String, default: '' },
  lockedColor:       { type: String, default: '' },
  lockedFolderId:    { type: Number, default: null },
  initialFiles:      { type: Array,  default: () => [] },
})
const emit = defineEmits(['close', 'uploaded'])

const fileInputRef    = ref(null)
const pendingFiles    = ref([])
const selectedId      = ref(null)
const selectedFolderId = ref(null)
const selectedStage   = ref('')
const isDragging      = ref(false)
const fileProgresses  = ref([])
let   dragCounter     = 0
const uploading       = ref(false)
const uploadedCount   = ref(0)
const doneExpanded    = ref(false)
const openYears       = ref(new Set())
const openMonths      = ref(new Set())

// 文件夹列表（从 API 加载）
const projectFolders  = ref([])

const effectiveProjectId = computed(() => props.lockedProjectId ?? selectedId.value)

const currentProjectStages = computed(() => {
  if (!effectiveProjectId.value) return []
  const proj = props.projects.find(p => p.id === effectiveProjectId.value)
  return proj?.stages ?? []
})

// 项目「当前阶段」对应的标签：current_stage 存的是 s0/s1… 的 key，
// 映射成 stage.label 作为文件标签的默认值（上传时自动打上）
function stageDefault(pid = effectiveProjectId.value) {
  if (!pid) return ''
  const proj = props.projects.find(p => p.id === pid)
  const cur = proj?.stages?.find(s => s.key === proj.currentStage)
  return cur?.label ?? ''
}

async function loadFolders(pid) {
  if (!pid) { projectFolders.value = []; return }
  try {
    projectFolders.value = await foldersApi.list(pid)
  } catch { projectFolders.value = [] }
}

watch(effectiveProjectId, (pid) => {
  selectedFolderId.value = null
  selectedStage.value = stageDefault(pid)   // 选中项目即默认打上其「当前阶段」标签（可改/可取消）
  loadFolders(pid)
}, { immediate: false })

watch(selectedId, () => {
  selectedFolderId.value = null
  // selectedStage 统一由 effectiveProjectId 监听设默认，避免两个监听顺序覆盖
})

watch(() => props.show, v => {
  if (v) {
    if (props.initialFiles.length) addFiles([...props.initialFiles])
    if (effectiveProjectId.value) loadFolders(effectiveProjectId.value)
    selectedStage.value = stageDefault()   // 打开即默认当前阶段（锁定项目入口此时 effectiveProjectId 监听不触发）
  } else {
    pendingFiles.value     = []
    selectedId.value       = null
    selectedFolderId.value = null
    selectedStage.value    = ''
    isDragging.value       = false
    dragCounter            = 0
    uploading.value        = false
    uploadedCount.value    = 0
    doneExpanded.value     = false
    projectFolders.value   = []
  }
})

const pendingProjects = computed(() => props.projects.filter(p => p.status === 'pending'))
const activeProjects  = computed(() => props.projects.filter(p => p.status === 'active'))
const doneProjects    = computed(() => props.projects.filter(p => p.status === 'done'))

function dateOf(p) {
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

function toggleYear(y) {
  const next = new Set(openYears.value)
  next.has(y) ? next.delete(y) : next.add(y)
  openYears.value = next
}
function toggleMonth(key) {
  const next = new Set(openMonths.value)
  next.has(key) ? next.delete(key) : next.add(key)
  openMonths.value = next
}

function fmtSize(bytes) {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

function extractColor(colorStr) {
  const m = colorStr?.match(/#[0-9a-fA-F]{3,6}/)
  return m ? m[0] : '#8a8fa8'
}

function handleFileInput(e) {
  const picked = [...e.target.files]
  addFiles(picked)
  e.target.value = ''
}

function handleDrop(e) {
  const dropped = [...(e.dataTransfer?.files ?? [])]
  addFiles(dropped)
}

function addFiles(newFiles) {
  const existing = new Set(pendingFiles.value.map(f => f.name + f.size))
  for (const f of newFiles) {
    if (!existing.has(f.name + f.size)) pendingFiles.value.push(f)
  }
}

function removeFile(i) {
  pendingFiles.value.splice(i, 1)
}

function handleClose() {
  if (uploading.value) return
  emit('close')
}

async function handleUpload() {
  if (pendingFiles.value.length === 0 || uploading.value) return
  uploading.value      = true
  uploadedCount.value  = 0
  fileProgresses.value = pendingFiles.value.map(() => 0)

  const projectId = effectiveProjectId.value
  const folderId  = props.lockedFolderId !== null ? props.lockedFolderId : selectedFolderId.value
  const space     = projectId ? 'project' : 'personal'
  const uploaded  = []

  try {
    for (let i = 0; i < pendingFiles.value.length; i++) {
      const f = pendingFiles.value[i]

      const presign = await filesApi.presign({
        filename:   f.name,
        size_bytes: f.size,
        mime_type:  f.type || 'application/octet-stream',
        space,
        project_id: projectId ?? null,
        folder_id:  folderId  ?? null,
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
          storage_key:  presign.storage_key,
          display_name: presign.final_name,
          ext:          presign.ext,
          mime_type:    f.type || 'application/octet-stream',
          size_bytes:   f.size,
          space,
          project_id: projectId ?? null,
          folder_id:  folderId  ?? null,
          stage_name: selectedStage.value,
        })
      } else {
        const form = new FormData()
        form.append('file', f)
        form.append('space', space)
        if (projectId != null) form.append('project_id', projectId)
        if (folderId  != null) form.append('folder_id', folderId)
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
    console.error('[UploadModal] 上传失败:', err.message)
    uploading.value = false
  }
}
</script>

<style scoped>
.modal { display: contents; }

.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid rgba(0,0,0,0.07);
  flex-shrink: 0;
}
.modal-header h2 { font-size: 16px; font-weight: 700; }

.close-btn {
  width: 28px; height: 28px; border-radius: 8px;
  background: rgba(0,0,0,0.05); border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary);
  transition: background 0.15s;
}
.close-btn:hover { background: rgba(0,0,0,0.1); }

.modal-body {
  flex: 1; overflow-y: auto;
  padding: 20px 24px;
  display: flex; flex-direction: column; gap: 18px;
}

/* ── 拖拽区 ── */
.drop-zone {
  border: 1.5px dashed rgba(123,127,178,0.35);
  border-radius: 14px;
  background: rgba(255,255,255,0.42);
  min-height: 148px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px;
  padding: 20px; cursor: pointer;
  transition: border-color 0.18s, background 0.18s;
}
.drop-zone:hover:not(.has-files) {
  border-color: rgba(123,127,178,0.6);
  background: rgba(123,127,178,0.04);
}
.drop-zone.dragging {
  border-color: #7b7fb2;
  border-style: solid;
  background: rgba(123,127,178,0.07);
}
.drop-zone.has-files {
  cursor: default;
  align-items: stretch;
  justify-content: flex-start;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.dz-icon { color: var(--text-secondary); opacity: 0.5; }
.dz-icon.pulse { opacity: 0.75; color: var(--color-primary); }

.dz-title {
  font-size: 13px; font-weight: 500; color: var(--text-secondary);
}
.dz-link {
  color: var(--color-primary); font-weight: 600; cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.dz-sub { font-size: 11px; color: var(--text-secondary); opacity: 0.6; }

/* 文件列表 */
.file-stack { display: flex; flex-direction: column; gap: 4px; width: 100%; }

.file-row {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,0.7);
  border: 1px solid rgba(255,255,255,0.88);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
}
.file-ext {
  font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
  color: var(--color-primary); background: rgba(123,127,178,0.12);
  border-radius: 5px; padding: 2px 6px; flex-shrink: 0;
}
.file-name {
  flex: 1; font-size: 12px; font-weight: 500; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}
.file-size { font-size: 11px; color: var(--text-secondary); flex-shrink: 0; }
.file-remove {
  width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  background: none; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-secondary); opacity: 0.4; transition: all 0.12s;
}
.file-remove:hover { background: rgba(176,120,88,0.1); color: var(--color-warning); opacity: 1; }

.add-more-btn {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  width: 100%; padding: 7px;
  border: 1.5px dashed rgba(123,127,178,0.3); border-radius: 9px;
  background: none; font-size: 11px; font-weight: 600;
  color: var(--text-secondary); cursor: pointer;
  font-family: var(--font-sans); transition: all 0.15s;
  flex-shrink: 0;
}
.add-more-btn:hover {
  background: rgba(123,127,178,0.06);
  border-color: rgba(123,127,178,0.5);
  color: var(--color-primary);
}

/* 项目选择 */
.field { display: flex; flex-direction: column; gap: 7px; }

label {
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 8px;
}
.label-hint {
  font-size: 10px; font-weight: 400;
  text-transform: none; letter-spacing: 0; opacity: 0.7;
}

.proj-list {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 200px; overflow-y: auto;
  padding-right: 2px;
}
.proj-list::-webkit-scrollbar { width: 3px; }
.proj-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 99px; }

.status-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
  color: var(--text-secondary); opacity: 0.6;
  text-transform: uppercase; padding: 2px 2px 0;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

.proj-group-chips { display: flex; flex-wrap: wrap; gap: 5px; }

.status-toggle {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 6px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  font-family: var(--font-sans); font-size: 11px; font-weight: 700;
  color: var(--text-secondary); letter-spacing: 0.04em;
  text-transform: uppercase; transition: background 0.12s;
}
.status-toggle:hover { background: rgba(0,0,0,0.04); }
.status-cnt { font-size: 10px; color: rgba(0,0,0,0.35); font-weight: 400; letter-spacing: 0; text-transform: none; }
.toggle-chev { color: rgba(0,0,0,0.28); transition: transform 0.2s cubic-bezier(0.34,1.1,0.64,1); flex-shrink: 0; }
.toggle-chev.open { transform: rotate(180deg); }

.done-tree { display: flex; flex-direction: column; gap: 1px; padding-left: 4px; }

.year-group { margin-bottom: 2px; }
.year-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 3px 6px; border: none; background: none;
  border-radius: 6px; cursor: pointer; font-family: var(--font-sans); text-align: left;
  transition: background 0.12s;
}
.year-row:hover { background: rgba(0,0,0,0.04); }
.year-chev { color: rgba(0,0,0,0.2); transition: transform 0.2s cubic-bezier(0.34,1.1,0.64,1); flex-shrink: 0; }
.year-chev.open { transform: rotate(180deg); }
.year-label { font-size: 12px; font-weight: 700; color: rgba(0,0,0,0.62); flex: 1; letter-spacing: 0.03em; }
.year-body { padding: 2px 0 2px 6px; border-left: 1px solid rgba(0,0,0,0.06); margin-left: 6px; margin-top: 1px; }

.month-group { margin-bottom: 1px; }
.month-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 3px 8px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  font-family: var(--font-sans); text-align: left; transition: background 0.12s;
}
.month-row:hover { background: rgba(0,0,0,0.04); }
.month-name { font-size: 11px; font-weight: 500; color: rgba(0,0,0,0.52); flex: 1; }
.month-chev { color: rgba(0,0,0,0.22); transition: transform 0.16s; }
.month-chev.open { transform: rotate(180deg); }

.month-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 4px 4px 4px 8px; }

.select-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 20px;
  border: 1px solid rgba(0,0,0,0.1);
  background: rgba(255,255,255,0.72);
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s; white-space: nowrap;
}
.select-btn:hover { background: rgba(255,255,255,0.9); color: var(--text-primary); }
.select-btn.active {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; border-color: transparent;
  box-shadow: 0 2px 8px rgba(123,127,178,0.28);
}
.p-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; opacity: 0.85; }
.no-proj-hint { font-size: 11px; color: var(--text-secondary); opacity: 0.65; }

.locked-hint label { margin-bottom: 4px; }
.locked-tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 20px;
  background: rgba(123,127,178,0.1);
  border: 1px solid rgba(123,127,178,0.2);
  font-size: 12px; font-weight: 500; color: var(--text-primary);
}

/* 上传进度 */
.upload-progress {
  display: flex; flex-direction: column; gap: 4px;
}
.up-file-row {
  position: relative; overflow: hidden;
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,0.7);
  border: 1px solid rgba(255,255,255,0.88);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
}
.up-fill {
  position: absolute; inset: 0; right: auto;
  background: rgba(123,127,178,0.12);
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}
.up-fill.done { background: rgba(90,158,136,0.13); }
.up-file-name {
  flex: 1; font-size: 12px; font-weight: 500; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  position: relative; padding-bottom: 2px; margin-bottom: -2px;
}
.up-status {
  width: 16px; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; position: relative;
}
.up-spinner {
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid rgba(123,127,178,0.25);
  border-top-color: #7b7fb2;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 底部 */
.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 24px;
  border-top: 1px solid rgba(0,0,0,0.07);
  flex-shrink: 0;
}
.btn-cancel {
  padding: 8px 18px; border-radius: var(--radius-sm);
  border: 1px solid rgba(0,0,0,0.1);
  background: rgba(255,255,255,0.72);
  font-size: 13px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s;
}
.btn-cancel:hover { background: rgba(255,255,255,0.88); color: var(--text-primary); }
.btn-upload {
  padding: 8px 22px; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; color: white;
  font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  box-shadow: 0 3px 12px rgba(123,127,178,0.3);
  transition: opacity 0.15s;
}
.btn-upload:hover:not(:disabled) { opacity: 0.85; }
.btn-upload:disabled { opacity: 0.45; cursor: not-allowed; }

/* 入场动画 */
</style>
