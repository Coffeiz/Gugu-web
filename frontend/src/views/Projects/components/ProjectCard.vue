<template>
  <div
    class="proj-card"
    :data-project-id="project.id"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
    :class="{ 'file-drag-over': fileDragOver }"
    @pointerdown="onPointerDown"
    @dragenter.prevent="onFileDragEnter"
    @dragover.prevent="onFileDragOver"
    @dragleave="onFileDragLeave"
    @drop.prevent="onFileDrop"
  >
    <div class="card-body">
      <div class="card-top">
        <div class="proj-name" :style="{ color: nameColor }">{{ project.name }}</div>
        <!-- 星级优先级 -->
        <div class="stars" @click.stop @mousedown.stop>
          <button
            v-for="n in 3"
            :key="n"
            class="star-btn"
            :class="{ active: prioValue >= n }"
            :title="PRIO_LABELS[n]"
            @click="setPriority(n)"
          >
            <svg width="11" height="11" viewBox="0 0 16 16">
              <polygon
                points="8,1.5 9.8,6 14.5,6.3 11,9.4 12.1,14 8,11.5 3.9,14 5,9.4 1.5,6.3 6.2,6"
                :fill="prioValue >= n ? starColor : 'none'"
                :stroke="prioValue >= n ? starColor : 'currentColor'"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="proj-meta">
        <span class="proj-client" :class="{ empty: !project.client }">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>
          </svg>
          {{ project.client }}
        </span>
        <span
          class="proj-stage"
          :class="{ open: stagePopOpen }"
          ref="stageRef"
          :title="currentStageLabel"
          @click.stop="openStagePop"
          @mousedown.stop
        >
          <span class="ps-label">{{ currentStageLabel || '阶段' }}</span>
          <span v-if="curTodoTotal" class="ps-count">{{ curDoneCount }}/{{ curTodoTotal }}</span>
          <svg class="ps-caret" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
        </span>
      </div>

      <div class="card-footer">
        <div class="date-range">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <rect x="1.5" y="2.5" width="13" height="12" rx="2"/>
            <path d="M5 1v3M11 1v3M1.5 6.5h13"/>
          </svg>
          <template v-if="project.status === 'done'">
            <span class="done-label"><PhCheck :size="9" weight="bold" /> 完成</span>
            <span v-if="project.doneAt" class="deadline">{{ fmtDate(project.doneAt.slice(0, 10)) }}</span>
          </template>
          <template v-else>
            <span v-if="project.startDate" class="date-start">{{ fmtDate(project.startDate) }}</span>
            <span v-if="project.startDate && project.deadline" class="date-sep">→</span>
            <span class="deadline" :class="{ urgent: isUrgent }">{{ deadlineLabel }}</span>
          </template>
        </div>
        <div class="footer-right">
          <span v-if="project.fileCount" class="file-badge">
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 1.5h5l2.5 2.5V10a.5.5 0 01-.5.5h-7A.5.5 0 011.5 10V2a.5.5 0 01.5-.5z"/>
              <path d="M7 1.5V4H9.5"/>
            </svg>
            {{ project.fileCount }}
          </span>
          <span class="progress-num">{{ stageProgress }}%</span>
        </div>
      </div>

      <div class="seg-bar-wrap" @click.stop @mousedown.stop>
        <SegBar :project="project" />
      </div>
    </div>

    <!-- 文件拖放 overlay -->
    <Transition name="drop-overlay">
      <div v-if="fileDragOver || fileUploading" class="drop-overlay"
           :style="{ background: fileUploading ? null : overlayHintBg }">
        <div v-if="fileUploading" class="upload-progress-bg"
             :style="{ width: (fileUploadDone ? 100 : fileUploadPct) + '%', background: uploadFillBg }"></div>
        <div class="drop-content" :style="{ color: nameColor }">
          <template v-if="fileUploading">
            <svg v-if="fileUploadDone" width="18" height="18" viewBox="0 0 24 24" fill="none" :stroke="nameColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" :stroke="nameColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>{{ fileUploadDone ? '已上传' : `${fileUploadPct}%` }}</span>
          </template>
          <template v-else>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" :stroke="nameColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>放入项目</span>
          </template>
        </div>
      </div>
    </Transition>

    <!-- 推进到下一阶段按钮，已完成不显示 -->
    <button
      v-if="project.status !== 'done'"
      class="card-advance"
      :title="advanceLabel"
      @click.stop="advance"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  </div>

  <!-- 当前阶段待办弹层（点击阶段名弹出） -->
  <Teleport to="body">
    <div v-if="stagePopOpen" class="todo-pop" :style="stagePopStyle" ref="stagePopRef" @click.stop @mousedown.stop>
      <div class="tp-header">
        <span class="tp-title">{{ currentStageLabel || '当前阶段' }}</span>
        <span v-if="curTodoTotal" class="tp-count">{{ curDoneCount }}/{{ curTodoTotal }}</span>
        <button class="popup-close-btn" @click="closeStagePop" title="关闭"><PhX :size="11" weight="bold" /></button>
      </div>
      <div v-if="curTodoTotal" class="tp-list">
        <div v-for="t in currentTodos" :key="t.id" class="tp-item">
          <button class="tp-check" :class="{ checked: t.done }" @click="toggleTodo(t)">
            <PhCheck v-if="t.done" :size="9" weight="bold" />
          </button>
          <input
            class="tp-input"
            v-model="t.text"
            :style="t.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
            placeholder="待办事项"
            @blur="persistTodos"
            @keydown.enter="persistTodos"
            @keydown.backspace="!t.text && removeTodo(t.id)"
          />
          <button class="tp-del" @click="removeTodo(t.id)" title="删除"><PhX :size="8" weight="bold" /></button>
        </div>
      </div>
      <div v-else class="tp-empty">还没有待办</div>
      <button class="tp-add" @click="addTodo">＋ 添加待办</button>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref, nextTick, onUnmounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { startPhysicsDrag } from '@/composables/usePhysicsDrag'
import { PhCheck, PhX } from '@phosphor-icons/vue'
import { filesApi, uploadWithProgress, uploadDirectWithProgress } from '@/services/api'
import SegBar from '@/components/common/SegBar.vue'

const props = defineProps({ project: { type: Object, required: true } })
const emit = defineEmits(['click'])

const projectStore = useProjectStore()

// 拖到哪一列就移到哪个状态：松手时据落点找列的 data-col-status（源卡此刻 display:none、克隆体 pointer-events:none，
// elementFromPoint 命中的就是底下真实的列）。同列不动 → 不触发 moveProject 的 API。
function dispatchDrop({ x, y }) {
  const el = document.elementFromPoint(x, y)
  const col = el && el.closest && el.closest('[data-col-status]')
  if (!col) return
  const status = col.getAttribute('data-col-status')
  if (status && status !== props.project.status) projectStore.moveProject(props.project.id, status)
}

// pointer 驱动拖拽（替代原生 HTML5 drag）：先攒位移，越过阈值才真正开拖——否则当成点击开项目。
// 内部控件（星级 / 阶段 / 进度条）自己处理点击，不在这里起拖。
function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  if (e.target.closest('.stars, .proj-stage, .seg-bar-wrap')) return
  const card = e.currentTarget
  const sx = e.clientX, sy = e.clientY
  let started = false
  const onMove = (ev) => {
    if (started || Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
    started = true
    teardown()
    startPhysicsDrag(ev, card, { pointer: true, skipAbsorb: true, onDrop: dispatchDrop })
  }
  const onUp = () => { teardown(); if (!started) emit('click') }   // 没拖动 = 点击 → 开项目
  const teardown = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
const cacheStore   = useFilesCacheStore()

const nameColor = computed(() => {
  const hex = props.project.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
  const r = Math.round(parseInt(hex.slice(1,3),16) * 0.40)
  const g = Math.round(parseInt(hex.slice(3,5),16) * 0.40)
  const b = Math.round(parseInt(hex.slice(5,7),16) * 0.40)
  return `rgb(${r},${g},${b})`
})

const _colorRgb = computed(() => {
  const hex = props.project.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
  const r = parseInt(hex.slice(1,3), 16)
  const g = parseInt(hex.slice(3,5), 16)
  const b = parseInt(hex.slice(5,7), 16)
  return `${r},${g},${b}`
})
const overlayHintBg  = computed(() => `rgba(${_colorRgb.value},0.12)`)
const uploadFillBg   = computed(() => `rgba(${_colorRgb.value},0.32)`)

const currentStageIndex = computed(() =>
  props.project.stages.findIndex(s => s.key === props.project.currentStage)
)
const currentStageLabel = computed(() =>
  props.project.stages[currentStageIndex.value]?.label ?? ''
)

// ── 当前阶段待办弹层（点击右侧阶段名弹出）────────────────────────
const currentStage = computed(() => props.project.stages[currentStageIndex.value] ?? null)
const currentTodos = computed(() => currentStage.value?.todos ?? [])
const curTodoTotal = computed(() => currentTodos.value.length)
const curDoneCount = computed(() => currentTodos.value.filter(t => t.done).length)

const stagePopOpen  = ref(false)
const stagePopStyle = ref({})
const stagePopRef   = ref(null)
const stageRef      = ref(null)

function openStagePop() {
  if (stagePopOpen.value) { closeStagePop(); return }
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect) return
  stagePopOpen.value = true
  nextTick(() => {
    const popW = 224
    const popH = stagePopRef.value?.offsetHeight ?? 180
    let left = rect.right - popW                          // 右对齐到阶段名右端
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8))
    let top = rect.bottom + 6                             // 默认在阶段名下方
    if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6   // 放不下转上方
    if (top < 8) top = 8
    stagePopStyle.value = { position: 'fixed', left: left + 'px', top: top + 'px', width: popW + 'px', zIndex: 11000 }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', closeStagePop, true)
  })
}
function closeStagePop() {
  if (!stagePopOpen.value) return
  stagePopOpen.value = false
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', closeStagePop, true)
}
function onDocDown(e) {
  if (stagePopRef.value && !stagePopRef.value.contains(e.target) &&
      stageRef.value && !stageRef.value.contains(e.target)) closeStagePop()
}
function onKey(e) { if (e.key === 'Escape') closeStagePop() }

function persistTodos() { projectStore.updateStages(props.project.id, props.project.stages) }
function toggleTodo(t) { t.done = !t.done; t.autoCompleted = false; persistTodos() }
function addTodo() {
  const s = currentStage.value; if (!s) return
  if (!s.todos) s.todos = []
  s.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
  persistTodos()
  nextTick(() => {
    const inputs = stagePopRef.value?.querySelectorAll('.tp-input')
    inputs?.[inputs.length - 1]?.focus()
  })
}
function removeTodo(id) {
  const s = currentStage.value; if (!s) return
  s.todos = (s.todos ?? []).filter(t => t.id !== id)
  persistTodos()
}

onUnmounted(closeStagePop)
const stageProgress = computed(() => {
  // 总完成度 = 所有阶段待办里已完成 / 总数（与总览页、项目编辑卡头部口径一致）；无待办则退回阶段位置
  const stages = props.project.stages
  if (!stages.length) return 0
  let done = 0, total = 0
  for (const s of stages) {
    const todos = s.todos ?? []
    done += todos.filter(t => t.done).length
    total += todos.length
  }
  if (total > 0) return Math.round(done / total * 100)
  const idx = currentStageIndex.value
  return idx < 0 ? 0 : Math.round((idx + 1) / stages.length * 100)
})

const daysLeft  = computed(() => {
  if (!props.project.deadline) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dl    = new Date(props.project.deadline + 'T00:00:00')
  return Math.ceil((dl - today) / 86400000)
})
const isUrgent = computed(() => props.project.status !== 'done' && daysLeft.value <= 3)
const thisYear = new Date().getFullYear()
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  const mm = `${d.getMonth()+1}/${d.getDate()}`
  return d.getFullYear() !== thisYear ? `${d.getFullYear()}/${mm}` : mm
}
const deadlineLabel = computed(() => {
  if (!props.project.deadline) return '—'
  const d = daysLeft.value
  if (d < 0) {
    if (props.project.status !== 'done') return `逾期 ${-d} 天`
    return fmtDate(props.project.deadline)
  }
  if (d === 0) return '今天截止'
  if (d === 1) return '明天'
  if (d <= 7)  return `${d}天后`
  return fmtDate(props.project.deadline)
})

// ── 推进状态列 ────────────────────────────────────────────
const STATUS_NEXT  = { pending: 'active', active: 'done' }
const STATUS_LABEL = { pending: '移至进行中', active: '标记完成' }
const advanceLabel = computed(() => STATUS_LABEL[props.project.status] ?? '')

async function advance() {
  const next = STATUS_NEXT[props.project.status]
  if (next) await projectStore.moveProject(props.project.id, next)
}

// ── 星级优先级 ────────────────────────────────────────────
// 1=低, 2=中, 3=高；null=无
const PRIO_MAP    = { low: 1, medium: 2, high: 3 }
const PRIO_LABELS = { 1: '低优先级', 2: '中优先级', 3: '高优先级' }
const PRIO_KEYS   = [null, 'low', 'medium', 'high']

const prioValue = computed(() => PRIO_MAP[props.project.priority] ?? 0)

const starColor = computed(() => {
  if (prioValue.value === 3) return '#c45050'
  if (prioValue.value === 2) return '#c49020'
  return '#8899cc'
})

// ── 文件拖放上传 ──────────────────────────────────────────────
const fileDragOver   = ref(false)
const fileUploading  = ref(false)
const fileUploadPct  = ref(0)
const fileUploadDone = ref(false)
let _dragEnterCount  = 0   // 处理子元素 dragleave 抖动

function _isFileDrag(e) { return e.dataTransfer?.types?.includes('Files') }

function onFileDragEnter(e) {
  if (!_isFileDrag(e)) return
  _dragEnterCount++
  fileDragOver.value = true
}
function onFileDragOver(e) {
  if (!_isFileDrag(e)) return
  e.dataTransfer.dropEffect = 'copy'
}
function onFileDragLeave(e) {
  if (!_isFileDrag(e)) return
  _dragEnterCount--
  if (_dragEnterCount <= 0) { _dragEnterCount = 0; fileDragOver.value = false }
}
async function onFileDrop(e) {
  _dragEnterCount = 0; fileDragOver.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length) return
  fileUploading.value = true; fileUploadPct.value = 0; fileUploadDone.value = false
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const presign = await filesApi.presign({
        filename: f.name, size_bytes: f.size,
        mime_type: f.type || 'application/octet-stream',
        space: 'project', project_id: props.project.id, folder_id: null, stage_name: '',
      })
      const onPct = (pct) => { fileUploadPct.value = Math.round(((i + pct) / files.length) * 100) }
      let uploaded
      if (presign.mode === 'oss') {
        await uploadDirectWithProgress(presign.upload_url, f, onPct)
        uploaded = await filesApi.confirm({
          storage_key: presign.storage_key, display_name: presign.final_name,
          ext: presign.ext, mime_type: f.type || 'application/octet-stream',
          size_bytes: f.size, space: 'project', project_id: props.project.id,
          folder_id: null, stage_name: '',
        })
      } else {
        const form = new FormData()
        form.append('file', f); form.append('space', 'project')
        form.append('project_id', props.project.id)
        uploaded = await uploadWithProgress('/files', form, onPct)
      }
      if (uploaded) cacheStore.addFile(uploaded)
    }
    fileUploadDone.value = true
    setTimeout(() => { fileUploading.value = false; fileUploadDone.value = false }, 1200)
  } catch (err) {
    fileUploading.value = false
    alert('上传失败：' + (err?.message ?? ''))
  }
}

async function setPriority(n) {
  // 再次点击同一级别则取消
  const next = prioValue.value === n ? null : PRIO_KEYS[n]
  await projectStore.updateProject(props.project.id, { priority: next })
}
</script>

<style scoped>
.proj-card {
  position: relative; display: flex; flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md);
  corner-shape: squircle;
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  overflow: hidden; cursor: pointer;
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.3s ease, background 0.25s ease-out;
  user-select: none;
}
.proj-card.file-drag-over {
  box-shadow: 0 0 0 2px rgba(123,127,178,0.6), 0 6px 18px rgba(80,90,110,0.13);
  transform: translateY(-2px);
}
.drop-overlay {
  position: absolute; inset: 0; border-radius: inherit; corner-shape: squircle;
  overflow: hidden; pointer-events: none; z-index: 10;
}
.upload-progress-bg {
  position: absolute; left: 0; top: 0; bottom: 0;
  transition: width 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.drop-content {
  position: relative; width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  font-size: 12px; font-weight: 600;
}
.drop-overlay-enter-active, .drop-overlay-leave-active { transition: opacity 0.15s; }
.drop-overlay-enter-from, .drop-overlay-leave-to { opacity: 0; }
.proj-card::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  corner-shape: squircle;   /* corner-shape 不随 border-radius:inherit 继承，需显式声明，否则圆角与卡片(squircle)不重合 → 双层圆角 */
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1);
  pointer-events: none;
}
.proj-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(80,90,110,0.13);
}
.proj-card:hover::after {
  background: linear-gradient(to top, rgba(255,255,255,0.25), rgba(255,255,255,0.05) 50%);
}
.proj-card:active:not(:has(.stars:active, .seg-bar-wrap:active, .proj-stage:active)) { transform: translateY(1px); opacity: 0.93; }

.card-body { flex: 1; padding: 13px 13px 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card-top { display: flex; align-items: flex-start; gap: 6px; }

.proj-name {
  font-size: 13px; font-weight: 500; color: var(--text-primary);
  line-height: 1.35; flex: 1; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.proj-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.proj-client {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-secondary);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1;
  padding-bottom: 2px; margin-bottom: -2px;
}
.proj-client svg { flex-shrink: 0; opacity: 0.85; }
.proj-client.empty { opacity: 0.75; }
.proj-stage {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; color: var(--text-secondary);
  white-space: nowrap; flex-shrink: 0; opacity: 0.75;
  padding: 2px 5px; margin: -2px -4px; border-radius: 6px;
  cursor: pointer; transition: background 0.12s, opacity 0.12s;
}
.proj-stage:hover, .proj-stage.open { background: rgba(0,0,0,0.06); opacity: 1; }
.ps-label { overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.ps-count { font-size: 9px; opacity: 0.8; font-variant-numeric: tabular-nums; }
.ps-caret { opacity: 0.5; flex-shrink: 0; transition: transform 0.16s; }
.proj-stage.open .ps-caret { transform: rotate(180deg); }

/* 当前阶段待办弹层（Teleport 到 body，通用弹窗风格） */
.todo-pop {
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.75); border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12);
  padding: 14px 14px 12px; font-family: var(--font-sans); box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px;
}
.tp-header { display: flex; align-items: center; gap: 6px; }
.tp-title { font-size: 13px; font-weight: 700; color: #1e2028; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-count { font-size: 11px; color: var(--text-secondary); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.tp-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.tp-list::-webkit-scrollbar { width: 3px; }
.tp-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.14); border-radius: 99px; }
.tp-item { display: flex; align-items: center; gap: 7px; padding: 3px 4px; border-radius: 8px; }
.tp-item:hover { background: rgba(0,0,0,0.04); }
.tp-check {
  width: 15px; height: 15px; border-radius: 5px; flex-shrink: 0;
  border: 1.5px solid rgba(0,0,0,0.22); background: none; color: #fff;
  display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
  transition: background 0.12s, border-color 0.12s;
}
.tp-check.checked { background: var(--color-primary); border-color: var(--color-primary); }
.tp-input {
  flex: 1; min-width: 0; border: none; background: none; outline: none;
  font-size: 12px; color: var(--text-primary); font-family: var(--font-sans); padding: 2px 0;
}
.tp-del {
  flex-shrink: 0; width: 16px; height: 16px; border: none; background: none;
  color: var(--text-secondary); opacity: 0; cursor: pointer; padding: 0; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.tp-item:hover .tp-del { opacity: 0.55; }
.tp-del:hover { opacity: 1 !important; background: rgba(200,80,80,0.12); color: #c85050; }
.tp-empty { font-size: 12px; color: var(--text-secondary); opacity: 0.55; text-align: center; padding: 6px 0 4px; }
.tp-add {
  width: 100%; padding: 6px; border: 1px dashed rgba(0,0,0,0.15);
  background: none; border-radius: 9px; font-size: 12px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.tp-add:hover { background: rgba(123,127,178,0.08); color: var(--color-primary); border-color: rgba(123,127,178,0.4); }

.card-footer { display: flex; align-items: center; justify-content: space-between; }
.footer-right { display: flex; align-items: center; gap: 5px; }

.date-range {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-secondary); min-width: 0; overflow: hidden;
}
.date-range svg { flex-shrink: 0; }
.date-start { opacity: 0.65; white-space: nowrap; }
.date-sep { opacity: 0.35; font-size: 9px; }
.deadline { white-space: nowrap; }
/* 用 inset 阴影代替 border、去掉纵向 padding，使胶囊不比正文行高更高 → 不把进度条挤下移 */
.done-label { white-space: nowrap; font-size: 10px; font-weight: 700; color: #3a8870; background: rgba(90,158,136,0.12); box-shadow: inset 0 0 0 1px rgba(90,158,136,0.35); border-radius: 20px; padding: 0 6px; display: inline-flex; align-items: center; gap: 2px; line-height: 1.4; }
.deadline.urgent { color: var(--color-warning); font-weight: 600; }

.file-badge {
  display: flex; align-items: center; gap: 3px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  background: rgba(0,0,0,0.06); border-radius: 10px; padding: 1px 6px;
}
.progress-num { font-size: 10px; color: var(--text-secondary); }
.seg-bar-wrap { position: relative; }

/* ── 星级 ── */
.stars { display: flex; align-items: center; gap: 0; }
.star-btn {
  width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; padding: 0; cursor: pointer;
  color: rgba(0,0,0,0.2);
  transition: transform 0.1s, color 0.1s;
}
.star-btn:hover { transform: scale(1.2); }
.star-btn.active { color: v-bind(starColor); }

/* ── 推进按钮（圆角靠父级 overflow:hidden 裁剪）── */
.card-advance {
  width: 42px; flex-shrink: 0; align-self: stretch;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none;
  border-left: 1px solid rgba(0,0,0,0.07);
  cursor: pointer;
  color: rgba(0,0,0,0.25);
  transition: background 0.15s, color 0.15s;
}
.card-advance:hover {
  background: rgba(0,0,0,0.05);
  color: var(--text-primary);
}
.card-advance:active { background: rgba(0,0,0,0.1); }
</style>
