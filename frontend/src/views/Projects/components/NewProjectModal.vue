<template>
  <BaseModal :show="show" width="480px" @close="$emit('close')">
    <div class="modal">

      <!-- 头部 -->
      <div class="modal-header">
        <button class="status-ball" :class="'sb-' + form.status" @click.stop="cycleStatus" :title="projectStore.kanbanColumns.find(c => c.key === form.status)?.label ?? form.status"></button>
        <input
          ref="nameInputRef"
          v-model="form.name"
          class="header-name-input"
          :class="{ error: errors.name }"
          placeholder="项目名称"
          @input="errors.name = ''"
        />
        <span v-if="errors.name" class="name-error">{{ errors.name }}</span>
        <button class="close-btn" @click="$emit('close')">
          <PhX :size="14" weight="bold" />
        </button>
      </div>

      <!-- 主体：单列 -->
      <div class="modal-body">
        <!-- 客户 & 项目周期 同行 -->
        <div class="section-row">
          <div class="field">
            <label>客户</label>
            <input v-model="form.client" placeholder="客户名称（选填）" />
          </div>
          <div class="field">
            <label>项目周期</label>
            <DateRangePicker
              v-model:startDate="form.startDate"
              v-model:endDate="form.deadline"
              placeholder="选择开始 — 截止"
            />
          </div>
        </div>

        <hr class="col-divider" />

        <!-- 项目颜色 -->
        <div class="section">
          <label class="section-label">项目颜色</label>
          <div class="color-grid">
            <button
              v-for="c in colorPresets"
              :key="c.value"
              class="color-chip"
              :class="{ active: form.color === c.value }"
              :style="{ background: c.value }"
              @click="form.color = c.value"
            >
              <PhCheck v-if="form.color === c.value" :size="11" weight="bold" style="color:white" />
            </button>
          </div>
        </div>

        <hr class="col-divider" />

        <div class="section stages-section">
            <div class="stages-header">
              <label class="section-label">
                项目阶段
                <span class="label-hint">拖拽排序</span>
              </label>
              <!-- 模板按钮 -->
              <div class="tpl-selector" ref="tplSelectorRef">
                <button class="tpl-trigger" @click.stop="tplOpen = !tplOpen">
                  <PhSquaresFour :size="11" weight="bold" />
                  模板
                </button>
                <Teleport to="body">
                  <Transition name="tpl-pop">
                    <div v-if="tplOpen" class="tpl-panel" :style="tplPanelStyle" ref="tplPanelRef">
                      <div class="tpl-panel-head">选择模板</div>

                      <!-- 模板列表 -->
                      <div class="tpl-list">
                        <div v-if="!templates.length" class="tpl-empty">暂无模板</div>
                        <div v-for="t in templates" :key="t.id" class="tpl-item">
                          <!-- 名称区：普通 or 重命名输入 -->
                          <button v-if="renamingId !== t.id" class="tpl-apply" @click.stop="applyTpl(t)">
                            <span class="tpl-name">{{ t.name }}</span>
                            <span class="tpl-stages-preview">{{ t.stages.map(s => s.label ?? s).join(' · ') }}</span>
                          </button>
                          <input
                            v-else
                            class="tpl-rename-input"
                            v-model="renameText"
                            @keyup.enter="commitRename(t.id)"
                            @keyup.esc="renamingId = null"
                            ref="renameInputRef"
                          />
                          <!-- 编辑/确认按钮（始终显示） -->
                          <button
                            class="tpl-rename-btn"
                            :title="renamingId === t.id ? '确认' : '重命名'"
                            @click.stop="renamingId === t.id ? commitRename(t.id) : startRename(t)"
                          >
                            <PhPencilSimple v-if="renamingId !== t.id" :size="10" weight="bold" />
                            <PhCheck v-else :size="10" weight="bold" />
                          </button>
                          <!-- 删除按钮（始终显示） -->
                          <button class="tpl-del-btn" title="删除" @click.stop="removeTemplate(t.id)">
                            <PhX :size="10" weight="bold" />
                          </button>
                        </div>
                      </div>

                      <div class="tpl-divider"></div>

                      <!-- 保存当前为模板 -->
                      <div v-if="!savingTpl" class="tpl-save-row">
                        <button class="tpl-save-btn" @click.stop="savingTpl = true">
                          <PhPlus :size="10" weight="bold" />
                          保存当前为模板
                        </button>
                      </div>
                      <div v-else class="tpl-save-input-row" @click.stop>
                        <input
                          class="tpl-name-input"
                          v-model="newTplName"
                          placeholder="模板名称"
                          @keyup.enter="commitSave"
                          @keyup.esc="savingTpl = false; newTplName = ''"
                          ref="tplNameInputRef"
                        />
                        <button class="tpl-rename-btn" title="保存" @click.stop="commitSave">
                          <PhCheck :size="10" weight="bold" />
                        </button>
                        <button class="tpl-del-btn" title="取消" @click.stop="savingTpl = false; newTplName = ''">
                          <PhX :size="10" weight="bold" />
                        </button>
                      </div>
                    </div>
                  </Transition>
                </Teleport>
              </div>
            </div>
            <div class="stages-editor" ref="stagesEditorRef">
              <div
                v-for="(stage, i) in displayStages" :key="stage.key"
                class="stage-block"
                :class="{ 'stage-dragging': stageDrag.active && stage.origIdx === stageDrag.fromIdx }"
              >
                <div class="stage-row" @mousedown="startStageDrag(stage.origIdx, $event)">
                  <div class="stage-num"
                    :class="{ 'stage-num--active': form.currentStageIdx === stage.origIdx }"
                    @click.stop="form.currentStageIdx = stage.origIdx"
                    title="设为当前阶段"
                  >{{ i + 1 }}</div>
                  <input
                    v-model="form.stages[stage.origIdx].label"
                    class="stage-input"
                    :placeholder="`阶段 ${i + 1}`"
                    @mousedown.stop
                    :ref="el => { if (el) stageInputRefs[stage.origIdx] = el }"
                  />
                  <button class="del-btn" @click.stop="removeStage(stage.origIdx)" :disabled="form.stages.length <= 1">
                    <PhX :size="10" weight="bold" />
                  </button>
                </div>
                <!-- 待办列表 -->
                <div class="np-todo-list">
                  <div v-for="todo in (form.stages[stage.origIdx].todos ?? [])" :key="todo.id" class="np-todo-item">
                    <button class="np-todo-check" :class="{ checked: todo.done }" @click.stop="todo.done = !todo.done">
                      <PhCheck v-if="todo.done" :size="8" weight="bold" />
                    </button>
                    <input
                      :class="['np-todo-input', `np-todo-input-${stage.origIdx}`]"
                      v-model="todo.text"
                      :title="todo.text"
                      :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
                      placeholder="待办事项"
                      @keydown.enter.prevent="addNpTodo(stage.origIdx)"
                      @keydown.backspace="!todo.text && removeNpTodo(stage.origIdx, todo.id)"
                    />
                    <button class="np-todo-del" @click.stop="removeNpTodo(stage.origIdx, todo.id)"><PhX :size="10" weight="bold" /></button>
                  </div>
                  <button class="np-todo-add-btn" @click.stop="addNpTodo(stage.origIdx)">＋ 添加待办</button>
                </div>
              </div>
              <button class="add-stage-btn" @click="addStage">
                <PhPlus :size="10" weight="bold" />
                添加阶段
              </button>
            </div>
        </div>
      </div>

      <!-- 底部 -->
      <div class="modal-footer">
        <button class="btn-cancel" @click="$emit('close')">取消</button>
        <button class="btn-create" @click="handleCreate">创建项目</button>
      </div>

      <Teleport to="body">
        <div v-if="stageDrag.active" class="np-stage-ghost"
          :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
          <div class="stage-num">{{ stageDrag.ghostNum }}</div>
          <span class="np-ghost-label">{{ stageDrag.ghostLabel || `阶段 ${stageDrag.ghostNum}` }}</span>
        </div>
      </Teleport>

    </div>
  </BaseModal>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import DateRangePicker from '@/components/common/DateSpanPicker.vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useStageTemplates } from '@/composables/useStageTemplates.js'
import { usePreferencesStore } from '@/stores/preferences'
import { onboardingProjectId } from '@/composables/useOnboarding'
import { PhX, PhCheck, PhPencilSimple, PhPlus, PhSquaresFour } from '@phosphor-icons/vue'

const props = defineProps({ show: Boolean, initStatus: { type: String, default: null } })
const emit  = defineEmits(['close'])

const projectStore    = useProjectStore()
const uiStore         = useUiStore()
const stagesEditorRef = ref(null)
const nameInputRef    = ref(null)
async function startNameEdit() {
  await nextTick()
  nameInputRef.value?.focus()
  nameInputRef.value?.select()
}

// ── 模板 ──
const { templates, applyTemplate, addTemplate, removeTemplate, renameTemplate } = useStageTemplates()
const tplOpen        = ref(false)
const tplSelectorRef = ref(null)
const tplPanelRef    = ref(null)
const tplPanelStyle  = ref({})
const savingTpl      = ref(false)
const newTplName     = ref('')
const tplNameInputRef = ref(null)
const renamingId     = ref(null)
const renameText     = ref('')
const renameInputRef = ref(null)

function openTplPanel() {
  const rect = tplSelectorRef.value?.getBoundingClientRect()
  if (!rect) return
  const panelW = 240
  let left = rect.right - panelW
  if (left < 8) left = 8
  tplPanelStyle.value = { position: 'fixed', top: rect.bottom + 4 + 'px', left: left + 'px', width: panelW + 'px', zIndex: 9999 }
}

watch(tplOpen, async v => {
  if (v) { openTplPanel(); await nextTick(); }
})

function applyTpl(t) {
  const stages = applyTemplate(t.id)
  if (!stages) return
  form.stages.splice(0, form.stages.length, ...stages)
  stageKeys.value = stages.map((_, i) => `sk_tpl_${i}_${Date.now()}`)
  tplOpen.value = false
}

async function commitSave() {
  const stages = form.stages.filter(s => s.label.trim())
  if (!stages.length) return
  if (addTemplate(newTplName.value, stages)) {
    savingTpl.value = false
    newTplName.value = ''
  }
}

function addNpTodo(origIdx) {
  const stage = form.stages[origIdx]
  if (!stage.todos) stage.todos = []
  stage.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
  nextTick(() => {
    const inputs = document.querySelectorAll(`.np-todo-input-${origIdx}`)
    inputs[inputs.length - 1]?.focus()
  })
}
function removeNpTodo(origIdx, id) {
  form.stages[origIdx].todos = (form.stages[origIdx].todos ?? []).filter(t => t.id !== id)
}


async function startRename(t) {
  renamingId.value = t.id
  renameText.value = t.name
  await nextTick()
  renameInputRef.value?.[0]?.focus()
}

function commitRename(id) {
  renameTemplate(id, renameText.value)
  renamingId.value = null
}

function onClickOutsideTpl(e) {
  if (!tplOpen.value) return
  if (tplSelectorRef.value?.contains(e.target)) return
  if (tplPanelRef.value?.contains(e.target)) return
  tplOpen.value = false
  savingTpl.value = false
  renamingId.value = null
}

onMounted(() => document.addEventListener('click', onClickOutsideTpl, true))
onUnmounted(() => document.removeEventListener('click', onClickOutsideTpl, true))

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function todayIso() { return toIso(new Date()) }
function weekLaterIso() {
  const d = new Date(); d.setDate(d.getDate() + 7); return toIso(d)
}

const colorPresets = [
  { value: 'linear-gradient(135deg,#c8aa72,#b88060)' },
  { value: 'linear-gradient(135deg,#8fbe8b,#7ab8a8)' },
  { value: 'linear-gradient(135deg,#7ab8a8,#7ab8c8)' },
  { value: 'linear-gradient(135deg,#7ab8c8,#7b7fb2)' },
  { value: 'linear-gradient(135deg,#5e73b2,#7b7fb2)' },
  { value: 'linear-gradient(135deg,#7b7fb2,#c4afc8)' },
  { value: 'linear-gradient(135deg,#c4afc8,#b07090)' },
  { value: 'linear-gradient(135deg,#be8b8f,#c8aa72)' },
]

const prefsStore = usePreferencesStore()

function getLastStages() {
  const toObj = s => ({ label: typeof s === 'string' ? s : (s.label ?? ''), todos: [] })
  if (prefsStore.lastStages.length) return prefsStore.lastStages.map(toObj)
  // 兜底复制「最近一个项目」的阶段——但**排除播种的教程项目**（它的阶段是教程，不该当新项目模板）
  const projects = projectStore.projects.filter(p => p.id !== onboardingProjectId.value)
  if (projects.length) {
    const last = [...projects].sort((a, b) => (b.id > a.id ? 1 : -1))[0]
    if (last.stages?.length) return last.stages.map(toObj)
  }
  return [{ label: '计划', todos: [] }, { label: '执行', todos: [] }, { label: '交付', todos: [] }]
}

const defaultForm = () => {
  const stages = getLastStages()
  return {
    name:             '',
    client:           '',
    startDate:        todayIso(),
    deadline:         weekLaterIso(),
    status:           'pending',
    color:            colorPresets[Math.floor(Math.random() * colorPresets.length)].value,
    stages,
    currentStageIdx:  0,
  }
}
const defaultKeys = () => getLastStages().map((_, i) => `s${i}`)

const form      = reactive(defaultForm())
const errors    = reactive({ name: '' })
const stageKeys = ref(defaultKeys())

const stageDrag = reactive({
  active: false, fromIdx: -1, overIdx: -1,
  ghostX: 0, ghostY: 0, ghostWidth: 200,
  ghostLabel: '', ghostNum: 1,
  grabOffsetX: 0, grabOffsetY: 0,
})

const displayStages = computed(() => {
  const items = form.stages.map((s, i) => ({ key: stageKeys.value[i] ?? `sk${i}`, label: s.label, origIdx: i }))
  if (!stageDrag.active) return items
  const arr = [...items]
  const [item] = arr.splice(stageDrag.fromIdx, 1)
  const to = Math.max(0, Math.min(stageDrag.overIdx, arr.length))
  arr.splice(to, 0, item)
  return arr
})

watch(() => props.show, async (v) => {
  if (v) {
    Object.assign(form, defaultForm())
    stageKeys.value = defaultKeys()
    if (props.initStatus) form.status = props.initStatus
    const range = uiStore.newProjectRange
    if (range) {
      form.startDate = range.start
      form.deadline  = range.end
      uiStore.newProjectRange = null
    }
    await nextTick()
    startNameEdit()
  }
})

const stageInputRefs = {}
async function addStage() {
  form.stages.push({ label: '', todos: [] })
  stageKeys.value.push(`sk${Date.now()}`)
  await nextTick()
  stageInputRefs[form.stages.length - 1]?.focus()
}
function removeStage(origIdx) {
  if (form.stages.length > 1) {
    form.stages.splice(origIdx, 1)
    stageKeys.value.splice(origIdx, 1)
    if (form.currentStageIdx >= form.stages.length) {
      form.currentStageIdx = form.stages.length - 1
    }
  }
}

function stageIdxFromY(y) {
  if (!stagesEditorRef.value) return -1
  const nodes = stagesEditorRef.value.querySelectorAll('.stage-row')
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
      stageDrag.active      = true
      stageDrag.fromIdx     = fromIdx
      stageDrag.overIdx     = fromIdx
      stageDrag.ghostLabel  = form.stages[fromIdx]?.label ?? ''
      stageDrag.ghostNum    = fromIdx + 1
      stageDrag.ghostWidth  = rect.width
      stageDrag.grabOffsetX = grabOffsetX
      stageDrag.grabOffsetY = grabOffsetY
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
  const stages = [...form.stages]
  const keys   = [...stageKeys.value]
  const [s] = stages.splice(fromIdx, 1)
  const [k] = keys.splice(fromIdx, 1)
  const to = Math.max(0, Math.min(overIdx, stages.length))
  stages.splice(to, 0, s)
  keys.splice(to, 0, k)
  form.stages.splice(0, form.stages.length, ...stages)
  stageKeys.value = keys
}

const INVALID_NAME_RE = /[\\/:*?"<>|]/

function cycleStatus() {
  const cols = projectStore.kanbanColumns
  const idx  = cols.findIndex(c => c.key === form.status)
  form.status = cols[(idx + 1) % cols.length].key
}

function handleCreate() {
  const name = form.name.trim()
  if (!name) { errors.name = '请填写项目名称'; return }
  if (INVALID_NAME_RE.test(name)) { errors.name = '不能包含：\\ / : * ? " < > |'; return }
  const stages = form.stages.filter(s => s.label.trim())
  prefsStore.saveLastStages(stages.map(s => s.label.trim()))
  projectStore.addProject({
    name:            name,
    client:          form.client.trim(),
    startDate:       form.startDate,
    deadline:        form.deadline,
    status:          form.status,
    color:           form.color,
    stages,
    currentStageIdx: form.currentStageIdx,
  })
  emit('close')
}
</script>

<style scoped>
:deep(.bm-card) { background: var(--panel-bg); }

.modal { display: contents; }

/* ── 头部 ── */
.modal-header {
  display: flex; align-items: center;
  gap: 12px; padding: 0 20px 0 16px; flex-shrink: 0;
  height: 52px; box-sizing: border-box;
  border-bottom: 1px solid rgba(0,0,0,0.07);
}
.status-ball {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  border: none; padding: 0; cursor: pointer; outline: none;
  transition: transform 0.15s, box-shadow 0.15s;
}
.status-ball:hover { transform: scale(1.2); }
.sb-pending { background: #d46b6b; box-shadow: 0 0 0 3px rgba(212,107,107,0.2); }
.sb-active  { background: #c9943a; box-shadow: 0 0 0 3px rgba(201,148,58,0.2); }
.sb-done    { background: #5a9e88; box-shadow: 0 0 0 3px rgba(90,158,136,0.2); }
/* 名称：默认像纯文本，悬停/聚焦才浮出编辑框（与定时任务卡 .title-input 同款样式+动画） */
.header-name-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-size: 17px; font-weight: 700; color: var(--text-primary);
  font-family: var(--font-sans); line-height: 1.2; outline: none;
  padding: 7px 8px; margin: 0;
  border: 1px solid rgba(0,0,0,0.1); border-radius: 10px; corner-shape: squircle;
  background: rgba(255,255,255,0.72); caret-color: var(--color-primary);   /* 与下方字段框统一：0.72 白底 + 0.1 边框 */
  transition: border-color 0.15s, box-shadow 0.15s;
}
.header-name-input::placeholder { color: var(--text-secondary); opacity: 0.45; font-weight: 700; }
.header-name-input:focus {
  border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
.header-name-input.error { color: var(--color-warning); }
.name-error {
  font-size: 11px; color: var(--color-warning); flex-shrink: 0;
}
.close-btn {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  background: rgba(0,0,0,0.05); border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary); transition: background 0.15s;
}
.close-btn:hover { background: rgba(0,0,0,0.1); }

/* ── 主体单列 ── */
.modal-body {
  display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto;
  padding: 14px 20px;
  max-height: calc(84vh - 120px);
}
.col-divider {
  border: none; height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
  margin: 0;
}

/* ── 通用 section & field ── */
.section { display: flex; flex-direction: column; gap: 8px; }
.section-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
  position: relative;
}
.section-row::after {
  content: '';
  position: absolute; left: 50%; top: -6px; bottom: -6px;
  width: 1px; transform: translateX(-50%);
  background: linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.07) 15%, rgba(0,0,0,0.07) 85%, transparent 100%);
  pointer-events: none;
}
.stages-section { display: flex; flex-direction: column; }
.field { display: flex; flex-direction: column; gap: 5px; }

label, .section-label {
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 7px;
}
.label-hint { font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 0.65; }

input[type="text"], input:not([type]):not(.name-input):not(.header-name-input) {
  width: 100%; padding: 8px 11px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  font-size: 13px; color: var(--text-primary);
  font-family: var(--font-sans); outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
input:not(.name-input):not(.header-name-input):focus {
  border-color: rgba(123,127,178,0.4);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}

/* ── 看板列 ── */
.status-group { display: flex; gap: 6px; }
.status-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 12px; border-radius: 20px;
  border: 1.5px solid transparent;
  background: rgba(0,0,0,0.04);
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s; white-space: nowrap; flex: 1; justify-content: center;
}
/* section-row 内紧凑版：缩小字号和内边距让三个按钮单行显示 */
.section-row .status-group { gap: 4px; }
.section-row .status-btn { font-size: 11px; padding: 4px 5px; gap: 4px; }
.status-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.s-pending .opt-dot { background: #d46b6b; }
.s-active  .opt-dot { background: #c9943a; }
.s-done    .opt-dot { background: #5a9e88; }
.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }

/* ── 颜色选择 ── */
.color-grid { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.color-chip {
  width: 28px; height: 28px; border-radius: 6px;
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, box-shadow 0.15s;
  padding: 0; outline: none; flex-shrink: 0;
}
/* section-row 内：缩小 chip 让 8 个单行排列 */
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active {
  border-color: #fff;
  box-shadow: 0 0 0 2px rgba(0,0,0,0.18);
}

/* ── 阶段头部 & 模板 ── */
.stages-header { display: flex; align-items: center; justify-content: space-between; }
.tpl-selector { position: relative; }
.tpl-trigger {
  display: flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 8px; border-radius: 6px; border: none;
  background: rgba(123,127,178,0.1); color: var(--color-primary);
  font-size: 11px; font-weight: 600; cursor: pointer;
  font-family: var(--font-sans); transition: background 0.15s;
}
.tpl-trigger:hover { background: rgba(123,127,178,0.18); }

/* 模板面板 */
.tpl-panel {
  background: rgba(255,255,255,0.96);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  padding: 4px 0; overflow: hidden;
}
.tpl-panel-head {
  font-size: 10px; font-weight: 700; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  padding: 2px 12px 6px;
}
.tpl-list { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; }
.tpl-empty { font-size: 12px; color: var(--text-secondary); opacity: 0.6; padding: 6px 12px; }
.tpl-item {
  display: flex; align-items: center; gap: 2px;
  padding: 0 6px 0 4px; min-height: 40px;
}
.tpl-apply {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 6px 8px; border: none; background: none; cursor: pointer;
  border-radius: 7px; text-align: left; transition: background 0.12s;
  font-family: var(--font-sans); min-width: 0;
}
.tpl-apply:hover { background: rgba(123,127,178,0.1); }
.tpl-name { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.tpl-stages-preview {
  font-size: 10px; color: var(--text-secondary); opacity: 0.7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;
}
.tpl-rename-btn, .tpl-del-btn {
  width: 22px; height: 22px; border-radius: 5px; border: none; background: none;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--text-secondary); flex-shrink: 0; transition: all 0.12s;
}
.tpl-rename-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.tpl-del-btn:hover { background: rgba(200,90,90,0.1); color: #c85a5a; }

.tpl-rename-input {
  flex: 1; align-self: stretch; padding: 0 8px; border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.9);
  font-size: 12px; font-family: var(--font-sans); outline: none; min-width: 0;
}
.tpl-rename-input:focus { border-color: rgba(123,127,178,0.4); }
.tpl-name-input { height: 28px;
  flex: 1; height: 26px; padding: 0 8px; border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.8);
  font-size: 12px; font-family: var(--font-sans); outline: none;
}
.tpl-rename-input:focus, .tpl-name-input:focus { border-color: rgba(123,127,178,0.4); }

.tpl-divider { height: 1px; background: rgba(0,0,0,0.07); margin: 4px 0; }
.tpl-save-row { padding: 2px 8px 4px; }
.tpl-save-btn {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 6px 8px; border-radius: 7px; border: none; background: none;
  font-size: 12px; color: var(--color-primary); font-weight: 500;
  cursor: pointer; font-family: var(--font-sans); transition: background 0.12s;
}
.tpl-save-btn:hover { background: rgba(123,127,178,0.1); }
.tpl-save-input-row {
  display: flex; align-items: center; gap: 2px; padding: 2px 6px 4px 4px;
}

.tpl-pop-enter-active { transition: opacity 0.14s, transform 0.16s cubic-bezier(0.34,1.2,0.64,1); }
.tpl-pop-leave-active { transition: opacity 0.1s, transform 0.1s ease-in; }
.tpl-pop-enter-from, .tpl-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-4px); }

/* ── 阶段编辑器 ── */
.stages-editor {
  display: flex; flex-direction: column; gap: 2px;
  padding: 0 8px 0 6px;
}
.stage-block { display: flex; flex-direction: column; }
.stage-block.stage-dragging { opacity: 0.15; pointer-events: none; }
.stage-row {
  display: flex; align-items: center; gap: 7px;
  position: relative; cursor: grab; transition: opacity 0.15s;
}
.stage-row::before {
  content: ''; position: absolute; left: -6px; top: 50%; transform: translateY(-50%);
  width: 2px; height: 14px; border-radius: 1px;
  background: var(--color-primary); opacity: 0; transition: opacity 0.15s;
}
.stage-row:hover::before { opacity: 0.4; }
.stage-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: rgba(123,127,178,0.15);
  font-size: 10px; font-weight: 700; color: var(--color-primary);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.stage-num--active {
  background: var(--color-primary);
  color: #fff;
}
.stage-input { flex: 1; padding: 6px 9px !important; font-size: 12.5px !important; }
.del-btn {
  width: 22px; height: 22px; border-radius: 6px;
  background: none; border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary);
  transition: all 0.15s; flex-shrink: 0;
}
.del-btn:hover:not(:disabled) { background: rgba(176,120,88,0.1); color: var(--color-warning); }
.del-btn:disabled { opacity: 0.2; cursor: not-allowed; }

/* 待办 */
.np-todo-list { padding: 2px 0 6px 27px; display: flex; flex-direction: column; gap: 0; margin-bottom: 3px;
  background-image: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.06) 20%, rgba(0,0,0,0.06) 80%, transparent 100%);
  background-size: 100% 1px; background-repeat: no-repeat; background-position: center bottom; }
.np-todo-item { display: flex; align-items: center; gap: 7px; height: 24px; }
.np-todo-item + .np-todo-item { border-top: 1px solid rgba(0,0,0,0.05); }
.np-todo-check {
  width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0;
  border: 1.5px solid rgba(0,0,0,0.18); background: rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, border-color 0.15s; padding: 0;
}
.np-todo-check.checked { background: var(--color-success); border-color: var(--color-success); color: white; }
.np-todo-input {
  flex: 1; font-size: 12px; font-family: var(--font-sans); color: var(--text-primary);
  border: 1.5px solid transparent; border-radius: 10px;
  background: transparent; outline: none; min-width: 0;
  padding: 0 5px !important; height: 24px; box-sizing: border-box;
  transition: background 0.15s, border-color 0.15s; width: 100% !important;
}
.np-todo-input:focus {
  background: rgba(255,255,255,0.88); border-color: rgba(123,127,178,0.45);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
}
.np-todo-del {
  width: 22px; height: 22px; border-radius: 6px;
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 0;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.np-todo-item:hover .np-todo-del { opacity: 0.4; }
.np-todo-del:hover { opacity: 1 !important; color: var(--color-warning); }
.np-todo-add-btn {
  display: flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 10px; border-radius: 7px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 11px; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; margin-top: 2px;
  margin-right: 29px;
}
.np-todo-add-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(123,127,178,0.06); }

.add-stage-btn {
  display: flex; align-items: center; gap: 6px;
  border: 1.5px dashed rgba(0,0,0,0.12);
  border-radius: var(--radius-sm); padding: 6px 9px;
  background: none; font-size: 12px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s; margin-left: 27px; margin-right: 29px;
  box-sizing: border-box;
}
.add-stage-btn:hover { background: rgba(255,255,255,0.72); color: var(--text-primary); border-color: rgba(123,127,178,0.3); }

/* ── 底部 ── */
.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid rgba(0,0,0,0.07);
  flex-shrink: 0;
}
.btn-cancel {
  padding: 7px 18px; border-radius: var(--radius-sm);
  border: 1px solid rgba(0,0,0,0.1);
  background: rgba(255,255,255,0.72);
  font-size: 13px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s;
}
.btn-cancel:hover { background: rgba(255,255,255,0.9); color: var(--text-primary); }
.btn-create {
  padding: 7px 22px; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; color: white;
  font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  box-shadow: 0 3px 12px rgba(123,127,178,0.3);
  transition: opacity 0.15s;
}
.btn-create:hover { opacity: 0.85; }
</style>

<style>
.np-stage-ghost {
  position: fixed; z-index: 9999; pointer-events: none;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px 6px 10px;
  background: rgba(238,240,246,0.94);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(123,127,178,0.28);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(30,40,80,0.16);
  opacity: 0.95;
  box-sizing: border-box;
}
.np-stage-ghost .stage-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: rgba(123,127,178,0.15);
  font-size: 10px; font-weight: 700; color: #7b7fb2;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; line-height: 1;
}
.np-ghost-label { font-size: 13px; color: #1e2028; font-weight: 500; line-height: 1; }
</style>
