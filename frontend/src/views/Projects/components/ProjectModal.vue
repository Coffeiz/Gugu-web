<template>
  <Transition name="modal" :duration="{ enter: 340, leave: 220 }">
    <div v-if="project" class="modal-wrap">
      <div class="modal-overlay" @click="$emit('close')" />

      <div class="modal">
        <!-- 悬浮删除按钮 -->
        <button class="del-float-btn" @click="handleDelete" title="删除此项目">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M3 5h10M6 5V3h4v2M5 5l.5 8h5l.5-8"/>
          </svg>
        </button>

        <!-- 左栏 -->
        <div class="modal-left">

          <!-- 紧凑标题区 -->
          <div class="proj-header">
            <div class="header-color-bar" :style="{ background: project.color }"></div>
            <div class="header-info">
              <input
                v-if="editingName"
                ref="nameInputRef"
                v-model="localName"
                class="header-name header-name-input"
                @blur="saveName"
                @keydown.enter="saveName"
                @keydown.esc="cancelName"
              />
              <div v-else class="header-name header-name-view" @click="startEditName" title="点击修改名称">{{ project.name }}</div>
              <div class="header-sub">
                <span class="header-progress" :style="{ color: accentColor }">{{ stageProgress }}%</span>
              </div>
              <div class="header-progress-bar">
                <div class="header-progress-fill" :style="{ width: stageProgress + '%', background: project.color }"></div>
              </div>
            </div>
          </div>

          <!-- 客户 -->
          <div class="client-row">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="client-icon">
              <circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>
            </svg>
            <input
              class="client-input"
              v-model="localClient"
              placeholder="输入客户名称"
            />
          </div>

          <!-- 日期编辑 -->
          <div class="meta-row">
            <div class="meta-item">
              <span class="meta-label">开始日期</span>
              <DatePicker ref="startPickerRef" v-model="localStartDate" placeholder="设置开始日期" @update:modelValue="onStartDatePicked" />
            </div>
            <div class="meta-item">
              <span class="meta-label">截止日期</span>
              <DatePicker ref="deadlinePickerRef" v-model="localDeadline" :min="localStartDate || undefined" placeholder="设置截止日期" />
              <span v-if="deadlineError" class="date-error">不能早于开始日期</span>
            </div>
          </div>

          <!-- 看板状态 -->
          <div class="status-row">
            <span class="meta-label">看板状态</span>
            <div class="status-btns">
              <button
                v-for="col in projectStore.kanbanColumns"
                :key="col.key"
                class="status-opt"
                :class="['s-' + col.key, { active: project.status === col.key }]"
                @click="projectStore.moveProject(project.id, col.key)"
              >
                <span class="opt-dot"></span>{{ col.label }}
              </button>
            </div>
          </div>

          <!-- 配色 -->
          <div class="color-row">
            <span class="meta-label">项目配色</span>
            <div class="color-grid">
              <button
                v-for="c in colorPresets"
                :key="c"
                class="color-chip"
                :class="{ active: project.color === c }"
                :style="{ background: c }"
                @click="setColor(c)"
              >
                <svg v-if="project.color === c" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round">
                  <path d="M2 6l3 3 5-5"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- 阶段编辑器 -->
          <div class="stages-section">
            <div class="section-label">
              项目阶段
              <button class="add-stage-btn" @click="addStage">＋ 添加</button>
            </div>
            <div class="stage-flow" ref="stageFlowRef">
              <div
                v-for="(stage, i) in displayStages" :key="stage.key"
                class="stage-node"
                :class="{
                  active: stage.key === project.currentStage && stage.key !== draggedStageKey,
                  done: doneStageKeys.has(stage.key) && stage.key !== draggedStageKey,
                  'stage-dragging': stageDrag.active && stage.key === draggedStageKey,
                }"
                @click="!stageDrag.active && setStage(stage.key)"
                @mousedown="editingStage !== stage.key && startStageDrag(localStages.indexOf(stage), $event)"
              >
                <div class="node-circle" :style="stage.key === project.currentStage && stage.key !== draggedStageKey ? { background: project.color, borderColor: project.color } : {}">
                  <svg v-if="doneStageKeys.has(stage.key) && stage.key !== draggedStageKey" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                  <span v-else class="node-num">{{ i + 1 }}</span>
                </div>
                <div class="node-body">
                  <input
                    v-if="editingStage === stage.key"
                    v-model="stage.label"
                    class="stage-input"
                    @blur="saveStages" @keydown.enter="saveStages" @keydown.esc="editingStage = null" @click.stop
                    ref="stageInputRef"
                  />
                  <span v-else class="node-label" @click.stop="startEdit(stage.key)">{{ stage.label }}</span>
                  <button class="del-stage" @click.stop="removeStage(stage.key)">
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>
                  </button>
                </div>
                <div v-if="i < displayStages.length - 1" class="node-line"></div>
              </div>
            </div>

            <!-- 拖拽虚影（圆圈 + 文字） -->
            <Teleport to="body">
              <div v-if="stageDrag.active" class="stage-drag-ghost-full"
                :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
                <div class="node-circle"
                  :style="stageDrag.ghostIsActive ? { background: project.color, borderColor: project.color } : {}">
                  <svg v-if="stageDrag.ghostIsDone" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg>
                  <span v-else class="node-num">{{ stageDrag.ghostNum }}</span>
                </div>
                <span class="node-label" :style="stageDrag.ghostIsActive ? { fontWeight: '700' } : {}">{{ stageDrag.ghostLabel }}</span>
              </div>
            </Teleport>
          </div>

          <!-- 备注 -->
          <div class="desc-section">
            <div class="section-label">备注</div>
            <textarea class="desc-input" placeholder="添加项目描述或备注…" rows="2"></textarea>
          </div>

        </div>

        <!-- 右栏：文件 -->
        <div class="modal-right">
          <div class="right-header">
            <span class="right-title">文件</span>
            <span class="right-count">{{ projectFiles.length }} 个文件</span>
            <button class="close-btn" @click="$emit('close')">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M3 3l10 10M13 3L3 13"/>
              </svg>
            </button>
          </div>
          <div class="file-content">
            <div class="file-grid">
              <div v-for="file in projectFiles" :key="file.id" class="fc-card">
                <div class="fc-top">
                  <span class="fc-ext">{{ file.ext }}</span>
                  <span class="fc-stage-dot" :style="{ background: accentColor }"></span>
                </div>
                <div class="fc-name">{{ file.displayName }}</div>
                <div class="fc-bottom">
                  <span class="fc-stage">{{ file.stage }}</span>
                  <span class="fc-meta">{{ file.versions[0]?.size }} · {{ file.versions[0]?.date }}</span>
                </div>
              </div>

              <label class="fc-upload" :class="{ dragging }"
                @dragover.prevent="dragging = true"
                @dragleave="dragging = false"
                @drop.prevent="handleFileDrop"
              >
                <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 12V3M5 7l4-4 4 4"/><path d="M2 14h14"/>
                </svg>
                <span>上传文件</span>
                <input type="file" hidden multiple @change="handleFileInput" />
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { filesApi } from '@/services/api'
import DatePicker from '@/components/common/DatePicker.vue'

const props = defineProps({ project: { type: Object, default: null } })
const emit = defineEmits(['close'])

const projectStore     = useProjectStore()
const editingStage     = ref(null)
const stageInputRef    = ref(null)
const stageFlowRef     = ref(null)
const stageDrag = reactive({
  active: false, fromIdx: -1, overIdx: -1,
  ghostX: 0, ghostY: 0, ghostLabel: '',
  ghostNum: 1, ghostIsActive: false, ghostIsDone: false,
  ghostWidth: 200, grabOffsetX: 0, grabOffsetY: 0,
})
const dragging         = ref(false)
const startPickerRef    = ref(null)
const deadlinePickerRef = ref(null)
const editingName      = ref(false)
const localName        = ref('')
const nameInputRef     = ref(null)

const localStages    = ref([])
const localStartDate = ref('')
const localDeadline  = ref('')
const localClient    = ref('')
const projectFiles   = ref([])

let initializing = false


watch(() => props.project?.id, async (id) => {
  initializing = true
  localStages.value    = props.project ? props.project.stages.map(s => ({ ...s })) : []
  localStartDate.value = props.project?.startDate ?? ''
  localDeadline.value  = props.project?.deadline  ?? ''
  localClient.value    = props.project?.client    ?? ''
  editingStage.value   = null
  projectFiles.value   = []
  await nextTick()
  initializing = false
  if (!id) return
  try {
    const data = await filesApi.list({ projectId: id })
    projectFiles.value = data
  } catch {
    // 后端未启动时保持空列表
  }
}, { immediate: true })

watch(localClient, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.client = v || null
  projectStore.updateProject(id, { client: v || null })
})

watch(localStartDate, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.startDate = v
  projectStore.updateProject(id, { startDate: v || null })
})

function onStartDatePicked(v) {
  startPickerRef.value?.closePicker()
  if (v) setTimeout(() => deadlinePickerRef.value?.openPicker(), 80)
}
const deadlineError = ref(false)

watch(localDeadline, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  if (v && localStartDate.value && v < localStartDate.value) {
    deadlineError.value = true
    return
  }
  deadlineError.value = false
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.deadline = v
  projectStore.updateProject(id, { deadline: v || null })
})

const currentStageIndex = computed(() =>
  localStages.value.findIndex(s => s.key === props.project?.currentStage)
)
const doneStageKeys = computed(() => {
  const idx = currentStageIndex.value
  if (idx <= 0) return new Set()
  return new Set(localStages.value.slice(0, idx).map(s => s.key))
})

const displayStages = computed(() => {
  if (!stageDrag.active) return localStages.value
  const stages = [...localStages.value]
  const [item] = stages.splice(stageDrag.fromIdx, 1)
  const to = Math.max(0, Math.min(stageDrag.overIdx, stages.length))
  stages.splice(to, 0, item)
  return stages
})
const draggedStageKey = computed(() =>
  stageDrag.active ? localStages.value[stageDrag.fromIdx]?.key : null
)
const displayCurrentStageIndex = computed(() =>
  displayStages.value.findIndex(s => s.key === props.project?.currentStage)
)
const stageProgress = computed(() => {
  const stages = localStages.value
  if (!stages.length) return 0
  const idx = currentStageIndex.value
  if (idx < 0) return 0
  return Math.round((idx + 1) / stages.length * 100)
})

function extractAccent(colorStr) {
  const m = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return m ? m[0] : '#7b7fb2'
}
const accentColor = computed(() => extractAccent(props.project?.color))

const colorPresets = [
  'linear-gradient(135deg,#c8aa72,#b88060)',
  'linear-gradient(135deg,#8fbe8b,#7ab8a8)',
  'linear-gradient(135deg,#7ab8a8,#7ab8c8)',
  'linear-gradient(135deg,#7ab8c8,#7b7fb2)',
  'linear-gradient(135deg,#5e73b2,#7b7fb2)',
  'linear-gradient(135deg,#7b7fb2,#c4afc8)',
  'linear-gradient(135deg,#c4afc8,#b07090)',
  'linear-gradient(135deg,#be8b8f,#c8aa72)',
]

function startEditName() {
  localName.value = props.project.name
  editingName.value = true
  nextTick(() => nameInputRef.value?.select())
}
function saveName() {
  const n = localName.value.trim()
  if (n && n !== props.project.name) {
    projectStore.updateProject(props.project.id, { name: n })
    const p = projectStore.projects.find(p => p.id === props.project.id)
    if (p) p.name = n
  }
  editingName.value = false
}
function cancelName() {
  editingName.value = false
}

function setColor(c) {
  const p = projectStore.projects.find(p => p.id === props.project?.id)
  if (p) p.color = c
  projectStore.updateProject(props.project.id, { color: c })
}

function setStage(key) { projectStore.setStage(props.project.id, key) }

async function handleDelete() {
  if (!props.project) return
  await projectStore.deleteProject(props.project.id)
  emit('close')
}

function startEdit(key) {
  editingStage.value = key
  nextTick(() => stageInputRef.value?.[0]?.focus())
}
function saveStages() {
  editingStage.value = null
  projectStore.updateStages(props.project.id, localStages.value)
}
function addStage() {
  const key = `stage_${Date.now()}`
  localStages.value.push({ key, label: '新阶段' })
  saveStages()
  nextTick(() => startEdit(key))
}
function removeStage(key) {
  if (localStages.value.length <= 1) return
  localStages.value = localStages.value.filter(s => s.key !== key)
  saveStages()
}

function stageIdxFromY(y) {
  if (!stageFlowRef.value) return -1
  const nodes = stageFlowRef.value.querySelectorAll('.stage-node')
  let best = -1, bestDist = Infinity
  nodes.forEach((el, i) => {
    const rect = el.getBoundingClientRect()
    const center = (rect.top + rect.bottom) / 2
    const d = Math.abs(y - center)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}

function startStageDrag(fromIdx, e) {
  const startX = e.clientX, startY = e.clientY
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  const grabOffsetX = e.clientX - rect.left
  const grabOffsetY = e.clientY - rect.top
  let activated = false

  const mm = (ev) => {
    if (!activated) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 4) return
      activated = true
      const stage = localStages.value[fromIdx]
      stageDrag.active       = true
      stageDrag.fromIdx      = fromIdx
      stageDrag.overIdx      = fromIdx
      stageDrag.ghostLabel   = stage?.label ?? ''
      stageDrag.ghostNum     = fromIdx + 1
      stageDrag.ghostIsActive = stage?.key === props.project?.currentStage
      stageDrag.ghostIsDone  = fromIdx < currentStageIndex.value
      stageDrag.ghostWidth   = rect.width
      stageDrag.grabOffsetX  = grabOffsetX
      stageDrag.grabOffsetY  = grabOffsetY
      document.body.style.cursor     = 'grabbing'
      document.body.style.userSelect = 'none'
    }
    stageDrag.ghostX  = ev.clientX - stageDrag.grabOffsetX
    stageDrag.ghostY  = ev.clientY - stageDrag.grabOffsetY
    stageDrag.overIdx = stageIdxFromY(ev.clientY)
  }

  const mu = () => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    if (activated) {
      commitStageDrag()
      document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
      setTimeout(() => { stageDrag.active = false; stageDrag.fromIdx = -1; stageDrag.overIdx = -1 }, 30)
    }
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

function commitStageDrag() {
  const { fromIdx, overIdx } = stageDrag
  if (fromIdx < 0 || fromIdx === overIdx) return
  const stages = [...localStages.value]
  const [moved] = stages.splice(fromIdx, 1)
  const to = Math.max(0, Math.min(overIdx, stages.length))
  stages.splice(to, 0, moved)
  localStages.value = stages
  saveStages()
}

async function handleFileInput(e) {
  const files = [...e.target.files]
  if (!files.length || !props.project) return
  for (const f of files) {
    try {
      const created = await filesApi.upload(f, {
        projectId: props.project.id,
        stage: props.project.stages[0]?.label ?? '—',
      })
      projectFiles.value.unshift(created)
    } catch { /* 离线时静默 */ }
  }
  e.target.value = ''
}

async function handleFileDrop(e) {
  dragging.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length || !props.project) return
  for (const f of files) {
    try {
      const created = await filesApi.upload(f, {
        projectId: props.project.id,
        stage: props.project.stages[0]?.label ?? '—',
      })
      projectFiles.value.unshift(created)
    } catch { /* 离线时静默 */ }
  }
}
</script>

<style scoped>
.modal-wrap {
  position: fixed; inset: 0; z-index: 200;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal button { outline: none; }
.modal-overlay {
  position: absolute; inset: 0;
  background: rgba(20,22,30,0.32);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.modal {
  position: relative;
  width: 100%; max-width: 900px; height: 100%; max-height: 680px;
  display: grid; grid-template-columns: 320px 1fr;
  background: rgba(238,240,246,0.92);
  backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 20px;
  corner-shape: squircle;
  box-shadow: 0 24px 64px rgba(20,25,50,0.22);
  overflow: hidden;
}

.close-btn {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  background: rgba(0,0,0,0.07); border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary); transition: background 0.15s;
}
.close-btn:hover { background: rgba(0,0,0,0.13); }

/* ── 左栏 ── */
.modal-left {
  display: flex; flex-direction: column;
  border-right: 1px solid rgba(0,0,0,0.07); overflow: hidden;
}

/* 紧凑标题区 */
.proj-header {
  display: flex; align-items: stretch; gap: 0;
  flex-shrink: 0; border-bottom: 1px solid rgba(0,0,0,0.07);
}
.header-color-bar {
  width: 5px; flex-shrink: 0;
}
.header-info {
  flex: 1; padding: 14px 16px 10px; min-width: 0;
  display: flex; flex-direction: column; gap: 5px;
}
.header-name {
  font-size: 19px; font-weight: 700; color: var(--text-primary);
  line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.header-name-view { cursor: text; border-radius: 5px; }
.header-name-view:hover { background: transparent; }
.header-name-input {
  width: 100%; border: none; outline: none;
  background: transparent; border-radius: 5px;
  padding: 1px 5px; margin: -1px -5px;
}
.header-sub {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px; color: var(--text-secondary);
}
.header-sub svg { flex-shrink: 0; opacity: 0.6; }
.header-client { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-progress { font-size: 11px; font-weight: 700; flex-shrink: 0; }
.header-progress-bar {
  height: 3px; background: rgba(0,0,0,0.07); border-radius: 99px; overflow: hidden;
}
.header-progress-fill { height: 100%; border-radius: 99px; transition: width 0.4s; }

/* 客户 */
.client-row {
  padding: 8px 14px; border-bottom: 1px solid rgba(0,0,0,0.07);
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.client-icon { color: var(--text-secondary); opacity: 0.75; flex-shrink: 0; }
.client-input {
  flex: 1; font-size: 12px; font-family: var(--font-sans);
  color: var(--text-primary); background: transparent;
  border: none; outline: none; padding: 0;
}
.client-input::placeholder { color: var(--text-secondary); opacity: 0.5; }

/* 日期 meta */
.meta-row {
  display: flex; border-bottom: 1px solid rgba(0,0,0,0.07); flex-shrink: 0;
}
.meta-item {
  flex: 1; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 5px;
  border-right: 1px solid rgba(0,0,0,0.07); min-width: 0;
}
.meta-item:last-child { border-right: none; }
.date-error { font-size: 10px; color: var(--color-warning); }
.meta-label { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }

/* 配色 */
.color-row {
  padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,0.07);
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
.color-grid { display: flex; gap: 7px; flex-wrap: wrap; }
.color-chip {
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s;
  padding: 0; outline: none;
}
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,0.18); }

/* 状态 */
.status-row {
  padding: 10px 14px; border-bottom: 1px solid rgba(0,0,0,0.07);
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
}
.status-btns { display: flex; gap: 5px; }
.status-opt {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 20px;
  border: 1.5px solid transparent; font-size: 11px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  outline: none;
}
.status-opt:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-opt.s-pending .opt-dot { background: #d46b6b; }
.status-opt.s-active  .opt-dot { background: #c9943a; }
.status-opt.s-done    .opt-dot { background: #5a9e88; }
.status-opt.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.status-opt.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.status-opt.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }

/* 阶段 */
.stages-section {
  padding: 14px 14px 0 6px; flex: 1; min-height: 0;
  display: flex; flex-direction: column;
}
.section-label {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
  flex-shrink: 0;
}
.stages-section .section-label { padding-left: 8px; }
.add-stage-btn {
  background: none; border: none; font-size: 11px; font-weight: 600;
  color: var(--color-primary); cursor: pointer; font-family: var(--font-sans);
  padding: 0; text-transform: none; letter-spacing: 0;
}
.add-stage-btn:hover { opacity: 0.7; }
.stage-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 3px 3px 10px 0; scrollbar-gutter: stable; }
.stage-node { display: flex; align-items: center; gap: 10px; position: relative; cursor: grab; transition: opacity 0.15s; padding: 0 0 14px 5px; }
.stage-node.stage-dragging { opacity: 0.15; pointer-events: none; }
.stage-node::before {
  content: ''; position: absolute; left: 0; top: 4px;
  width: 2px; height: 14px; border-radius: 1px;
  background: var(--color-primary); opacity: 0; transition: opacity 0.15s;
}
.node-circle {
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(0,0,0,0.15); background: rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: all 0.2s; z-index: 1;
}
.stage-node.done .node-circle { background: var(--color-success); border-color: var(--color-success); }
.stage-node.active .node-circle { box-shadow: 0 0 0 3px rgba(123,127,178,0.2); }
.node-num { font-size: 10px; font-weight: 700; color: var(--text-secondary); line-height: 1; }
.stage-node.active .node-num { color: #fff; }
.node-body { flex: 1; display: flex; align-items: center; justify-content: space-between; }
.node-label { font-size: 13px; color: var(--text-primary); }
.stage-node.done .node-label { color: var(--text-secondary); text-decoration: line-through; }
.stage-node.active .node-label { font-weight: 600; }
.stage-input {
  font-size: 13px; font-family: var(--font-sans);
  border: 1px solid rgba(123,127,178,0.4); border-radius: 6px; padding: 1px 6px;
  background: rgba(255,255,255,0.8); outline: none; color: var(--text-primary); width: 110px;
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
}
.del-stage {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 2px;
  display: flex; align-items: center;
}
.stage-node:hover .del-stage { opacity: 0.5; }
.stage-node:hover::before { opacity: 0.4; }
.stage-node.stage-dragging::before { opacity: 0.8; }
.del-stage:hover { opacity: 1 !important; color: var(--color-warning); }
.node-line { position: absolute; left: 16px; top: 22px; width: 2px; height: 14px; background: rgba(0,0,0,0.08); }
.stage-node.done .node-line { background: var(--color-success); opacity: 0.4; }

/* 备注 */
.desc-section { padding: 10px 16px 14px; flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; border-top: 1px solid rgba(0,0,0,0.07); }

/* 悬浮删除按钮 */
.del-float-btn {
  position: absolute; bottom: 14px; right: 14px; z-index: 10;
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(176,120,88,0.1);
  border: 1px solid rgba(176,120,88,0.25);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-warning);
  box-shadow: 0 2px 10px rgba(176,120,88,0.15);
  transition: background 0.15s, box-shadow 0.15s;
}
.del-float-btn:hover {
  background: rgba(176,120,88,0.18);
  box-shadow: 0 4px 14px rgba(176,120,88,0.25);
}
.desc-input {
  width: 100%; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px; padding: 10px 12px;
  font-size: 13px; font-family: var(--font-sans); color: var(--text-primary);
  background: rgba(255,255,255,0.72); outline: none; resize: none; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box;
}
.desc-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.desc-input::placeholder { color: var(--text-secondary); opacity: 0.6; }

/* ── 右栏：文件 ── */
.modal-right { display: flex; flex-direction: column; min-height: 0; }
.right-header {
  padding: 10px 12px 10px 16px; border-bottom: 1px solid rgba(0,0,0,0.07);
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.right-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.right-count { font-size: 11px; color: var(--text-secondary); flex: 1; }


.file-content { flex: 1; overflow-y: auto; padding: 14px; }

.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}

/* FilePanel 风格卡片 */
.fc-card {
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.85);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
  padding: 9px 10px 8px;
  cursor: pointer; display: flex; flex-direction: column; gap: 4px;
  transition: box-shadow 0.2s, background 0.2s;
}
.fc-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 12px rgba(80,90,110,0.1);
  background: rgba(255,255,255,0.82);
}
.fc-card:active { opacity: 0.85; }

.fc-top { display: flex; align-items: center; justify-content: space-between; }
.fc-ext {
  font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
  color: var(--color-primary); background: rgba(123,127,178,0.12);
  border-radius: 4px; padding: 2px 5px;
}
.fc-stage-dot { width: 7px; height: 7px; border-radius: 50%; opacity: 0.75; flex-shrink: 0; }
.fc-name {
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;
}
.fc-bottom { display: flex; flex-direction: column; gap: 1px; }
.fc-stage {
  font-size: 10px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fc-meta { font-size: 9px; color: var(--text-secondary); opacity: 0.7; }

.fc-upload {
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md); min-height: 80px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 5px;
  color: var(--text-secondary); font-size: 10px;
  cursor: pointer; background: rgba(255,255,255,0.2); transition: all 0.18s;
}
.fc-upload:hover, .fc-upload.dragging {
  border-color: rgba(123,127,178,0.5);
  color: var(--color-primary); background: rgba(123,127,178,0.05);
}

/* ── 动画 ── */
.modal-enter-active .modal-overlay { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.modal-leave-active .modal-overlay { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.modal-enter-from .modal-overlay, .modal-leave-to .modal-overlay { opacity: 0; }
.modal-enter-active .modal { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.modal-leave-active .modal { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.modal-enter-from .modal, .modal-leave-to .modal { opacity: 0; }
</style>

<style>
.stage-drag-ghost-full {
  position: fixed; z-index: 9999; pointer-events: none;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 6px 12px 6px 10px;
  background: rgba(238,240,246,0.94);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(123,127,178,0.3);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(30,40,80,0.18);
  opacity: 0.92; transform: rotate(-1deg) scale(1.02);
  box-sizing: border-box;
}
.stage-drag-ghost-full .node-circle {
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(0,0,0,0.15); background: rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.stage-drag-ghost-full .node-num {
  font-size: 10px; font-weight: 700; color: #6b7280;
}
.stage-drag-ghost-full .node-label {
  font-size: 13px; color: #1e2028; line-height: 22px;
  font-weight: 500;
}
</style>
