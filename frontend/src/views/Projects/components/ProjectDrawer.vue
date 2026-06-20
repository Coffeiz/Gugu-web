<template>
  <Transition name="drawer">
    <div v-if="project" class="drawer-wrap">
      <!-- 半透明遮罩 -->
      <div class="drawer-overlay" @click="$emit('close')" />

      <!-- 抽屉主体 -->
      <div class="drawer">
        <!-- 头部 -->
        <div class="drawer-header">
          <div class="proj-color-bar" :style="{ background: project.color }"></div>
          <div class="header-info">
            <h2>{{ project.name }}</h2>
            <span class="client-tag">{{ project.client }}</span>
          </div>
          <button class="close-btn" @click="$emit('close')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

        <!-- 内容 -->
        <div class="drawer-body">
          <!-- 进度 & 阶段 -->
          <section class="section">
            <div class="section-row">
              <div class="meta-item">
                <span class="meta-label">当前阶段</span>
                <span class="stage-badge" :style="{ color: stageColor, background: stageColorBg }">
                  {{ stageLabel }}
                </span>
              </div>
              <div class="meta-item">
                <span class="meta-label">截止日期</span>
                <span class="meta-value" :class="{ urgent: isUrgent }">{{ project.deadline }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">完成进度</span>
                <span class="meta-value">{{ project.progress }}%</span>
              </div>
            </div>

            <!-- 大进度条 -->
            <div class="big-progress">
              <div class="big-progress-fill"
                :style="{ width: project.progress + '%', background: project.color }">
              </div>
            </div>
          </section>

          <!-- 阶段流转 -->
          <section class="section">
            <div class="section-label">流转阶段</div>
            <div class="stage-flow">
              <button
                v-for="stage in projectStore.stages"
                :key="stage.key"
                class="stage-btn"
                :class="{ active: project.stage === stage.key }"
                @click="setStage(stage.key)"
              >
                {{ stage.label }}
              </button>
            </div>
          </section>

          <!-- 任务列表（Mock） -->
          <section class="section">
            <div class="section-label">任务清单
              <span class="task-count">{{ mockTasks.filter(t=>t.done).length }}/{{ mockTasks.length }}</span>
            </div>
            <div class="task-list">
              <div
                v-for="task in mockTasks"
                :key="task.id"
                class="task-item"
                @click="task.done = !task.done"
              >
                <div class="task-check" :class="{ done: task.done }">
                  <svg v-if="task.done" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                </div>
                <span :class="{ 'task-done': task.done }">{{ task.name }}</span>
              </div>
            </div>
          </section>

          <!-- 文件 -->
          <section class="section">
            <div class="section-label">
              相关文件
              <span class="file-count" v-if="totalFileCount > 0">{{ totalFileCount }}</span>
              <div class="file-actions">
                <button class="file-action-btn" title="新建文件夹" @click.stop="showNewFolder = !showNewFolder">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M2 4a1 1 0 011-1h2.5l1 1.5H11a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/><path d="M7 7v2.5M5.5 8.5h3"/>
                  </svg>
                </button>
                <button class="file-action-btn upload" title="上传文件" @click.stop="uploadOpen = true">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M7 9V3M4 6l3-3 3 3"/><path d="M1 11h12"/>
                  </svg>
                </button>
              </div>
            </div>

            <!-- 新建文件夹输入框 -->
            <div v-if="showNewFolder" class="new-folder-row" @click.stop>
              <input
                class="new-folder-input"
                v-model="newFolderName"
                placeholder="文件夹名称"
                @keyup.enter="createFolder"
                @keyup.esc="showNewFolder = false; newFolderName = ''"
                ref="folderInputRef"
                autofocus
              />
              <button class="btn-confirm-sm" :disabled="folderLoading" @click="createFolder">确定</button>
              <button class="btn-cancel-sm" @click="showNewFolder = false; newFolderName = ''">✕</button>
            </div>

            <!-- 文件夹列表 -->
            <div v-if="folders.length" class="folder-rows">
              <div v-for="folder in folders" :key="folder.id" class="folder-row" @click="toggleFolder(folder.id)">
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                  <path d="M1 3.5a1 1 0 011-1h2.5l1 1.5H12a1 1 0 011 1v5a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z" :fill="openFolders.has(folder.id) ? 'rgba(123,127,178,0.15)' : 'none'"/>
                </svg>
                <span class="folder-name">{{ folder.name }}</span>
                <span class="folder-cnt">{{ folder.fileCount }}</span>
                <svg class="folder-chev" :class="{ open: openFolders.has(folder.id) }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M2 3.5l3 3 3-3"/>
                </svg>
              </div>
              <!-- 展开的文件夹内文件 -->
              <template v-for="folder in folders" :key="'files-' + folder.id">
                <div v-if="openFolders.has(folder.id)" class="folder-files">
                  <div v-if="!folderFiles[folder.id]?.length" class="empty-hint">暂无文件</div>
                  <div v-for="f in folderFiles[folder.id]" :key="f.id" class="file-item indented">
                    <div class="file-icon" :style="{ background: fileIconColor(f.ext) }">{{ f.ext }}</div>
                    <div class="file-info">
                      <div class="file-name">{{ f.displayName }}</div>
                      <div class="file-meta">{{ f.size }} · {{ f.createdAt }}</div>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <!-- 根目录文件 -->
            <div v-if="rootFiles.length" class="file-list">
              <div v-for="f in rootFiles" :key="f.id" class="file-item">
                <div class="file-icon" :style="{ background: fileIconColor(f.ext) }">{{ f.ext }}</div>
                <div class="file-info">
                  <div class="file-name">{{ f.displayName }}</div>
                  <div class="file-meta">{{ f.size }} · {{ f.createdAt }}</div>
                </div>
              </div>
            </div>

            <div v-if="!folders.length && !rootFiles.length && !filesLoading" class="empty-hint">
              暂无文件，点击右上角上传
            </div>
          </section>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 上传弹窗 -->
  <UploadModal
    :show="uploadOpen"
    :projects="projectStore.projects"
    :locked-project-id="project?.id ?? null"
    :locked-project-name="project?.name ?? ''"
    :locked-color="project ? extractColor(project.color) : ''"
    :locked-folder-id="null"
    @close="uploadOpen = false"
    @uploaded="onUploaded"
  />
  </Transition>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { filesApi, foldersApi } from '@/services/api'
import UploadModal from '@/views/Files/UploadModal.vue'

const props = defineProps({
  project: { type: Object, default: null },
})
defineEmits(['close'])

const projectStore = useProjectStore()

const stageColors = {
  draft:    { color: '#8a8fa8', bg: 'rgba(138,143,168,0.1)' },
  sketch:   { color: '#7b7fb2', bg: 'rgba(123,127,178,0.1)' },
  coloring: { color: '#b07090', bg: 'rgba(196,175,200,0.12)' },
  final:    { color: '#7ab8c8', bg: 'rgba(122,184,200,0.1)' },
  delivery: { color: '#5a9e88', bg: 'rgba(90,158,136,0.1)' },
}

const stageColor   = computed(() => stageColors[props.project?.stage]?.color   ?? '#8a8fa8')
const stageColorBg = computed(() => stageColors[props.project?.stage]?.bg      ?? 'rgba(0,0,0,0.05)')
const stageLabel   = computed(() =>
  projectStore.stages.find(s => s.key === props.project?.stage)?.label ?? ''
)

const daysLeft = computed(() => {
  if (!props.project?.deadline) return 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.ceil((new Date(props.project.deadline + 'T00:00:00') - today) / 86400000)
})
const isUrgent = computed(() => daysLeft.value <= 3)

function setStage(key) {
  if (props.project) projectStore.moveProject(props.project.id, key)
}

// Mock 任务
const mockTasks = ref([
  { id: 1, name: '确认项目需求与参考图', done: true },
  { id: 2, name: '绘制草图并发送审稿', done: true },
  { id: 3, name: '线稿细化', done: false },
  { id: 4, name: '配色方案确认', done: false },
  { id: 5, name: '最终交付文件整理', done: false },
])

watch(() => props.project?.id, () => {
  mockTasks.value.forEach(t => { t.done = t.id <= 2 })
})

// ── 文件 / 文件夹 ──────────────────────────────────────────────────────────────

const folders      = ref([])
const rootFiles    = ref([])
const folderFiles  = ref({})   // { [folderId]: File[] }
const openFolders  = ref(new Set())
const filesLoading = ref(false)

const totalFileCount = computed(() =>
  rootFiles.value.length + folders.value.reduce((s, f) => s + (f.fileCount ?? 0), 0)
)

const EXT_COLORS = {
  PDF: 'linear-gradient(135deg,#e07070,#c45050)',
  PSD: 'linear-gradient(135deg,#7ab8c8,#4a8ea0)',
  AI:  'linear-gradient(135deg,#e09050,#c07030)',
  PNG: 'linear-gradient(135deg,#7b9fe0,#5070c0)',
  JPG: 'linear-gradient(135deg,#7b9fe0,#5070c0)',
  ZIP: 'linear-gradient(135deg,#9e9fc4,#7b7fb2)',
  MP4: 'linear-gradient(135deg,#b07090,#905070)',
}
function fileIconColor(ext) {
  return EXT_COLORS[ext?.toUpperCase()] ?? 'linear-gradient(135deg,#8a8fa8,#6a6f88)'
}

function extractColor(color) {
  if (!color) return '#7b7fb2'
  const m = color.match(/#[0-9a-fA-F]{3,8}/)
  return m ? m[0] : '#7b7fb2'
}

async function loadFiles() {
  if (!props.project?.id) return
  filesLoading.value = true
  openFolders.value  = new Set()
  folderFiles.value  = {}
  try {
    const [apifolders, apifiles] = await Promise.all([
      foldersApi.list({ projectId: props.project.id }),
      filesApi.list({ space: 'project', projectId: props.project.id }),
    ])
    folders.value   = apifolders
    rootFiles.value = apifiles
  } catch (e) {
    console.error('[ProjectDrawer] 文件加载失败:', e.message)
  } finally {
    filesLoading.value = false
  }
}

async function toggleFolder(folderId) {
  const next = new Set(openFolders.value)
  if (next.has(folderId)) {
    next.delete(folderId)
  } else {
    next.add(folderId)
    if (!folderFiles.value[folderId]) {
      try {
        folderFiles.value = { ...folderFiles.value, [folderId]: await filesApi.list({ folderId }) }
      } catch { folderFiles.value = { ...folderFiles.value, [folderId]: [] } }
    }
  }
  openFolders.value = next
}

watch(() => props.project?.id, (id) => {
  if (id) loadFiles()
  else { folders.value = []; rootFiles.value = [] }
}, { immediate: true })

// ── 新建文件夹 ────────────────────────────────────────────────────────────────

const showNewFolder  = ref(false)
const newFolderName  = ref('')
const folderLoading  = ref(false)
const folderInputRef = ref(null)

watch(showNewFolder, v => { if (v) nextTick(() => folderInputRef.value?.focus()) })

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || !props.project?.id) return
  folderLoading.value = true
  try {
    await foldersApi.create(props.project.id, name)
    newFolderName.value = ''
    showNewFolder.value = false
    await loadFiles()
  } catch (e) {
    console.error('[ProjectDrawer] 新建文件夹失败:', e.message)
  } finally {
    folderLoading.value = false
  }
}

// ── 上传 ─────────────────────────────────────────────────────────────────────

const uploadOpen = ref(false)

async function onUploaded() {
  uploadOpen.value = false
  await loadFiles()
}
</script>

<style scoped>
/* 整体容器 */
.drawer-wrap {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  justify-content: flex-end;
}

/* 遮罩 */
.drawer-overlay {
  position: absolute;
  inset: 0;
  background: rgba(30,32,40,0.22);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

/* 抽屉主体 */
.drawer {
  position: relative;
  width: 380px;
  height: 100%;
  background: rgba(240,241,246,0.88);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-left: 1px solid rgba(255,255,255,0.65);
  box-shadow: -8px 0 40px rgba(80,90,110,0.14);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 头部 */
.drawer-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 24px 20px 18px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  flex-shrink: 0;
}

.proj-color-bar {
  width: 4px;
  height: 44px;
  border-radius: 99px;
  flex-shrink: 0;
  margin-top: 2px;
}

.header-info {
  flex: 1;
  min-width: 0;
}

.header-info h2 {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-primary);
}

.client-tag {
  display: inline-block;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  background: rgba(0,0,0,0.05);
  border-radius: 20px;
  padding: 2px 9px;
}

.close-btn {
  background: rgba(0,0,0,0.05);
  border: none;
  border-radius: 8px;
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background 0.15s;
  flex-shrink: 0;
}
.close-btn:hover { background: rgba(0,0,0,0.1); }

/* 内容区 */
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 通用分区 */
.section { display: flex; flex-direction: column; gap: 10px; }

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* meta 行 */
.section-row {
  display: flex;
  gap: 16px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-label {
  font-size: 10px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.meta-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.meta-value.urgent { color: var(--color-warning); }

.stage-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 20px;
  display: inline-block;
}

/* 大进度条 */
.big-progress {
  height: 5px;
  background: rgba(0,0,0,0.08);
  border-radius: 99px;
  overflow: hidden;
}

.big-progress-fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.4s cubic-bezier(.34,1.2,.64,1);
}

/* 阶段流转 */
.stage-flow {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.stage-btn {
  padding: 5px 12px;
  border-radius: 20px;
  border: 1px solid rgba(0,0,0,0.1);
  background: rgba(255,255,255,0.72);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-family: var(--font-sans);
}

.stage-btn:hover {
  background: rgba(255,255,255,0.8);
  color: var(--text-primary);
}

.stage-btn.active {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 8px rgba(123,127,178,0.3);
}

/* 任务 */
.task-count {
  font-size: 10px;
  color: var(--text-secondary);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.task-list { display: flex; flex-direction: column; gap: 6px; }

.task-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
  color: var(--text-primary);
}

.task-item:hover { background: rgba(255,255,255,0.65); }

.task-check {
  width: 16px; height: 16px;
  border-radius: 5px;
  border: 1.5px solid rgba(0,0,0,0.18);
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}

.task-check.done {
  background: var(--color-success);
  border-color: var(--color-success);
}

.task-done {
  text-decoration: line-through;
  color: var(--text-secondary);
}

/* 文件区 section-label 扩展 */
.file-count {
  font-size: 10px; color: var(--text-secondary);
  font-weight: 400; text-transform: none; letter-spacing: 0;
}
.file-actions { margin-left: auto; display: flex; gap: 4px; }
.file-action-btn {
  width: 22px; height: 22px; border-radius: 6px; border: none;
  background: rgba(0,0,0,0.05); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-secondary); transition: background 0.15s, color 0.15s;
}
.file-action-btn:hover { background: rgba(0,0,0,0.1); color: var(--text-primary); }
.file-action-btn.upload:hover { background: rgba(123,127,178,0.15); color: var(--color-primary); }

/* 新建文件夹行 */
.new-folder-row {
  display: flex; gap: 6px; align-items: center;
}
.new-folder-input {
  flex: 1; height: 30px; padding: 0 10px; border-radius: 8px; font-size: 12px;
  border: 1.5px solid rgba(123,127,178,0.4); background: rgba(255,255,255,0.8);
  color: var(--text-primary); outline: none; font-family: var(--font-sans);
}
.new-folder-input:focus { border-color: var(--color-primary); }
.btn-confirm-sm, .btn-cancel-sm {
  height: 30px; padding: 0 10px; border-radius: 8px; border: none;
  font-size: 12px; cursor: pointer; font-family: var(--font-sans);
}
.btn-confirm-sm { background: var(--color-primary); color: white; }
.btn-confirm-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel-sm  { background: rgba(0,0,0,0.07); color: var(--text-secondary); }

/* 文件夹行 */
.folder-rows { display: flex; flex-direction: column; gap: 2px; }
.folder-row {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px; border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.55); border: 1px solid rgba(255,255,255,0.65);
  cursor: pointer; font-size: 13px; color: var(--text-primary);
  transition: background 0.15s;
}
.folder-row:hover { background: rgba(255,255,255,0.8); }
.folder-name { flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; margin-bottom: -2px; }
.folder-cnt  { font-size: 11px; color: var(--text-secondary); }
.folder-chev { transition: transform 0.2s; flex-shrink: 0; }
.folder-chev.open { transform: rotate(180deg); }
.folder-files {
  padding-left: 14px; display: flex; flex-direction: column; gap: 4px; margin-bottom: 2px;
}

/* 文件 */
.file-list { display: flex; flex-direction: column; gap: 4px; }
.file-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px;
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: var(--radius-sm);
}
.file-item.indented { background: rgba(255,255,255,0.5); }

.file-icon {
  width: 30px; height: 30px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 8px; font-weight: 700; color: white;
  letter-spacing: 0.04em; flex-shrink: 0;
}

.file-info { flex: 1; min-width: 0; }
.file-name { font-size: 12px; font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; margin-bottom: -2px; }
.file-meta { font-size: 11px; color: var(--text-secondary); margin-top: 1px; }

.empty-hint { font-size: 12px; color: var(--text-secondary); padding: 4px 2px; }

/* 抽屉动画 */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.22s;
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform 0.28s cubic-bezier(.34,1.1,.64,1);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
