<template>
  <BaseModal :show="show" width="620px" @close="$emit('close')">
      <div class="modal">
        <!-- 头部 -->
        <div class="modal-header">
          <h2>新建项目</h2>
          <button class="close-btn" @click="$emit('close')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

        <!-- 表单 -->
        <div class="modal-body">
          <!-- 基本信息 -->
          <div class="form-row">
            <div class="field flex-2">
              <label>项目名称 <span class="required">*</span></label>
              <input ref="nameInputRef" v-model="form.name" placeholder="输入项目名称" :class="{ error: errors.name }" @input="errors.name = ''" />
              <span v-if="errors.name" class="error-msg">{{ errors.name }}</span>
            </div>
            <div class="field flex-1">
              <label>客户 / 委托方</label>
              <input v-model="form.client" placeholder="客户名称（选填）" />
            </div>
          </div>

          <div class="divider"></div>

          <!-- 时间 -->
          <div class="form-row">
            <div class="field flex-1">
              <label>开始日期</label>
              <DatePicker ref="startPickerRef" v-model="form.startDate" placeholder="选择开始日期" @update:modelValue="onStartDatePicked" />
            </div>
            <div class="field flex-1">
              <label>截止日期</label>
              <DatePicker ref="deadlinePickerRef" v-model="form.deadline" :min="form.startDate || undefined" placeholder="选择截止日期" />
            </div>
          </div>

          <div class="divider"></div>

          <!-- 看板列 -->
          <div class="field">
            <label>看板列</label>
            <div class="select-group">
              <button
                v-for="col in projectStore.kanbanColumns"
                :key="col.key"
                class="select-btn"
                :class="['s-' + col.key, { active: form.status === col.key }]"
                @click="form.status = col.key"
              >
                <span class="opt-dot"></span>{{ col.label }}
              </button>
            </div>
          </div>

          <div class="divider"></div>

          <!-- 颜色选择 -->
          <div class="field">
            <label>项目颜色</label>
            <div class="color-grid">
              <button
                v-for="c in colorPresets"
                :key="c.value"
                class="color-chip"
                :class="{ active: form.color === c.value }"
                :style="{ background: c.value }"
                @click="form.color = c.value"
              >
                <svg v-if="form.color === c.value" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round">
                  <path d="M2 6l3 3 5-5"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="divider"></div>

          <!-- 自定义阶段 -->
          <div class="field">
            <label>
              项目阶段
              <span class="label-hint">拖拽排序，点击修改名称</span>
            </label>
            <div class="stages-editor" ref="stagesEditorRef">
              <div
                v-for="(stage, i) in displayStages" :key="stage.key"
                class="stage-row"
                :class="{ 'stage-dragging': stageDrag.active && stage.origIdx === stageDrag.fromIdx }"
                @mousedown="startStageDrag(stage.origIdx, $event)"
              >
                <div class="stage-num">{{ i + 1 }}</div>
                <input
                  v-model="form.stages[stage.origIdx]"
                  class="stage-input"
                  :placeholder="`阶段 ${i + 1}`"
                  @mousedown.stop
                />
                <button class="del-btn" @click.stop="removeStage(stage.origIdx)" :disabled="form.stages.length <= 1">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M2 2l6 6M8 2L2 8"/>
                  </svg>
                </button>
              </div>
              <button class="add-stage-btn" @click="addStage">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 1v10M1 6h10"/>
                </svg>
                添加阶段
              </button>
            </div>
          </div>

          <Teleport to="body">
            <div v-if="stageDrag.active" class="np-stage-ghost"
              :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
              <div class="stage-num">{{ stageDrag.ghostNum }}</div>
              <span class="np-ghost-label">{{ stageDrag.ghostLabel || `阶段 ${stageDrag.ghostNum}` }}</span>
            </div>
          </Teleport>
        </div>

        <!-- 底部操作 -->
        <div class="modal-footer">
          <button class="btn-cancel" @click="$emit('close')">取消</button>
          <button class="btn-create" @click="handleCreate">创建项目</button>
        </div>
      </div>
  </BaseModal>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { useProjectStore } from '@/stores/projects'
import DatePicker from '@/components/common/DatePicker.vue'
import BaseModal from '@/components/common/BaseModal.vue'

const props = defineProps({ show: Boolean })
const emit  = defineEmits(['close'])

const projectStore    = useProjectStore()
const startPickerRef    = ref(null)
const deadlinePickerRef = ref(null)
const stagesEditorRef   = ref(null)
const nameInputRef      = ref(null)

function onStartDatePicked(v) {
  startPickerRef.value?.closePicker()
  if (v) setTimeout(() => deadlinePickerRef.value?.openPicker(), 80)
}

function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
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

const defaultForm = () => ({
  name:      '',
  client:    '',
  startDate: todayIso(),
  deadline:  todayIso(),
  status:    'pending',
  color:     colorPresets[Math.floor(Math.random() * colorPresets.length)].value,
  stages:    ['计划', '执行', '交付'],
})
const defaultKeys = () => ['s0', 's1', 's2']

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
  const items = form.stages.map((label, i) => ({ key: stageKeys.value[i] ?? `sk${i}`, label, origIdx: i }))
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
    await nextTick()
    nameInputRef.value?.focus()
  }
})

function addStage() {
  form.stages.push('')
  stageKeys.value.push(`sk${Date.now()}`)
}
function removeStage(origIdx) {
  if (form.stages.length > 1) {
    form.stages.splice(origIdx, 1)
    stageKeys.value.splice(origIdx, 1)
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
      stageDrag.ghostLabel  = form.stages[fromIdx] ?? ''
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

function handleCreate() {
  const name = form.name.trim()
  if (!name) { errors.name = '请填写项目名称'; return }
  if (INVALID_NAME_RE.test(name)) { errors.name = '不能包含：\\ / : * ? " < > |'; return }
  projectStore.addProject({
    name:      name,
    client:    form.client.trim(),
    startDate: form.startDate,
    deadline:  form.deadline,
    status:    form.status,
    color:     form.color,
    stages:    form.stages.filter(s => s.trim()).map(s => s.trim()),
  })
  emit('close')
}
</script>

<style scoped>
/* .modal 保留作为 flex 子项的布局容器 */
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
  display: flex; flex-direction: column; gap: 16px;
}
.divider { height: 1px; background: rgba(0,0,0,0.07); margin: 0 -24px; }

.form-row { display: flex; gap: 14px; }
.flex-1 { flex: 1; min-width: 0; }
.flex-2 { flex: 2; min-width: 0; }

.field { display: flex; flex-direction: column; gap: 6px; }

label {
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 8px;
}
.required { color: var(--color-warning); font-size: 13px; }
.label-hint { font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 0.7; }

input[type="text"], input:not([type]) {
  width: 100%; padding: 9px 12px;
  background: rgba(255,255,255,0.6);
  border: 1px solid rgba(255,255,255,0.8);
  border-radius: var(--radius-sm);
  font-size: 13px; color: var(--text-primary);
  font-family: var(--font-sans); outline: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
input:focus {
  border-color: rgba(123,127,178,0.45);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.12);
}
input.error { border-color: rgba(176,120,88,0.5); }
input::placeholder { color: var(--text-secondary); opacity: 0.6; }

.error-msg { font-size: 11px; color: var(--color-warning); }

.select-group { display: flex; gap: 5px; flex-wrap: wrap; }
.select-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 20px;
  border: 1.5px solid transparent;
  background: rgba(0,0,0,0.04);
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s; white-space: nowrap;
}
.select-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.s-pending .opt-dot { background: #d46b6b; }
.s-active  .opt-dot { background: #c9943a; }
.s-done    .opt-dot { background: #5a9e88; }
.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }

.color-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.color-chip {
  width: 32px; height: 32px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s;
  padding: 0; outline: none;
}
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active {
  border-color: #fff;
  box-shadow: 0 0 0 2px rgba(0,0,0,0.18);
}

.stages-editor { display: flex; flex-direction: column; gap: 6px; }
.stage-row {
  display: flex; align-items: center; gap: 8px;
  position: relative; cursor: grab;
  transition: opacity 0.15s;
}
.stage-row::before {
  content: ''; position: absolute; left: -6px; top: 50%; transform: translateY(-50%);
  width: 2px; height: 14px; border-radius: 1px;
  background: var(--color-primary); opacity: 0; transition: opacity 0.15s;
}
.stage-row:hover::before { opacity: 0.4; }
.stage-row.stage-dragging { opacity: 0.15; pointer-events: none; }
.stage-row.stage-dragging::before { opacity: 0.8; }
.stage-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: rgba(123,127,178,0.15);
  font-size: 10px; font-weight: 700; color: var(--color-primary);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.stage-input { flex: 1; padding: 7px 10px !important; font-size: 13px !important; }
.del-btn {
  width: 24px; height: 24px; border-radius: 6px;
  background: none; border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary);
  transition: all 0.15s; flex-shrink: 0;
}
.del-btn:hover:not(:disabled) { background: rgba(176,120,88,0.1); color: var(--color-warning); }
.del-btn:disabled { opacity: 0.2; cursor: not-allowed; }

.add-stage-btn {
  display: flex; align-items: center; gap: 6px;
  border: 1.5px dashed rgba(0,0,0,0.12);
  border-radius: var(--radius-sm); padding: 7px 10px;
  background: none; font-size: 13px; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans);
  transition: all 0.15s;
  margin-left: 28px; margin-right: 32px;
  box-sizing: border-box;
}
.add-stage-btn:hover { background: rgba(255,255,255,0.72); color: var(--text-primary); border-color: rgba(123,127,178,0.3); }

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
.btn-cancel:hover { background: rgba(255,255,255,0.8); color: var(--text-primary); }
.btn-create {
  padding: 8px 22px; border-radius: var(--radius-sm);
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
  padding: 7px 12px 7px 10px;
  background: rgba(238,240,246,0.94);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(123,127,178,0.28);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(30,40,80,0.16);
  opacity: 0.92; transform: rotate(-1deg) scale(1.02);
  box-sizing: border-box;
}
.np-stage-ghost .stage-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: rgba(123,127,178,0.15);
  font-size: 10px; font-weight: 700; color: #7b7fb2;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; line-height: 1;
}
.np-ghost-label {
  font-size: 13px; color: #1e2028; font-weight: 500; line-height: 1;
}
</style>
