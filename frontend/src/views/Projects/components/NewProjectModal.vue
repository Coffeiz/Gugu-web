<template>
  <BaseModal :show="show" width="700px" @close="$emit('close')">
    <div class="modal">

      <!-- 头部 -->
      <div class="modal-header">
        <div class="header-color-bar" :style="{ background: form.color }"></div>
        <input
          ref="nameInputRef"
          v-model="form.name"
          class="name-input"
          :class="{ error: errors.name }"
          placeholder="项目名称"
          @input="errors.name = ''"
        />
        <span v-if="errors.name" class="name-error">{{ errors.name }}</span>
        <button class="close-btn" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 3l10 10M13 3L3 13"/>
          </svg>
        </button>
      </div>

      <!-- 主体：左右两栏 -->
      <div class="modal-body">

        <!-- 左栏：基本信息 -->
        <div class="left-col">

          <div class="section">
            <div class="field">
              <label>客户 / 委托方</label>
              <input v-model="form.client" placeholder="客户名称（选填）" />
            </div>
            <div class="field">
              <label>项目周期</label>
              <DateRangePicker
                v-model:startDate="form.startDate"
                v-model:endDate="form.deadline"
                placeholder="选择开始 — 截止日期"
              />
            </div>
          </div>

          <hr class="col-divider" />

          <div class="section">
            <label class="section-label">看板列</label>
            <div class="status-group">
              <button
                v-for="col in projectStore.kanbanColumns"
                :key="col.key"
                class="status-btn"
                :class="['s-' + col.key, { active: form.status === col.key }]"
                @click="form.status = col.key"
              >
                <span class="opt-dot"></span>{{ col.label }}
              </button>
            </div>
          </div>

          <hr class="col-divider" />

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
                <svg v-if="form.color === c.value" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round">
                  <path d="M2 6l3 3 5-5"/>
                </svg>
              </button>
            </div>
          </div>

          <hr class="col-divider" />

          <div class="section">
            <label class="section-label">备注</label>
            <textarea class="notes-input" v-model="form.notes" placeholder="添加项目描述或备注…" rows="3"></textarea>
          </div>

        </div>

        <!-- 右栏：阶段 -->
        <div class="right-col">

          <div class="section stages-section">
            <div class="stages-header">
              <label class="section-label">
                项目阶段
                <span class="label-hint">拖拽排序</span>
              </label>
              <!-- 模板按钮 -->
              <div class="tpl-selector" ref="tplSelectorRef">
                <button class="tpl-trigger" @click.stop="tplOpen = !tplOpen">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <rect x="1" y="1" width="5" height="5" rx="1.5"/>
                    <rect x="8" y="1" width="5" height="5" rx="1.5"/>
                    <rect x="1" y="8" width="5" height="5" rx="1.5"/>
                    <rect x="8" y="8" width="5" height="5" rx="1.5"/>
                  </svg>
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
                            <span class="tpl-stages-preview">{{ t.stages.join(' · ') }}</span>
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
                            <svg v-if="renamingId !== t.id" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z"/></svg>
                            <svg v-else width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg>
                          </button>
                          <!-- 删除按钮（始终显示） -->
                          <button class="tpl-del-btn" title="删除" @click.stop="removeTemplate(t.id)">
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>
                          </button>
                        </div>
                      </div>

                      <div class="tpl-divider"></div>

                      <!-- 保存当前为模板 -->
                      <div v-if="!savingTpl" class="tpl-save-row">
                        <button class="tpl-save-btn" @click.stop="savingTpl = true">
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v10M1 6h10"/></svg>
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
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg>
                        </button>
                        <button class="tpl-del-btn" title="取消" @click.stop="savingTpl = false; newTplName = ''">
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l6 6M8 2L2 8"/></svg>
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
                  :ref="el => { if (el) stageInputRefs[stage.origIdx] = el }"
                />
                <button class="del-btn" @click.stop="removeStage(stage.origIdx)" :disabled="form.stages.length <= 1">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M2 2l6 6M8 2L2 8"/>
                  </svg>
                </button>
              </div>
              <button class="add-stage-btn" @click="addStage">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 1v10M1 6h10"/>
                </svg>
                添加阶段
              </button>
            </div>
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
import DateRangePicker from '@/components/common/DateSpanPicker.vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useStageTemplates } from '@/composables/useStageTemplates.js'

const props = defineProps({ show: Boolean })
const emit  = defineEmits(['close'])

const projectStore    = useProjectStore()
const stagesEditorRef = ref(null)
const nameInputRef    = ref(null)

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
  const stages = form.stages.filter(s => s.trim()).map(s => s.trim())
  if (!stages.length) return
  if (addTemplate(newTplName.value, stages)) {
    savingTpl.value = false
    newTplName.value = ''
  }
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

function getLastStages() {
  const projects = projectStore.projects
  if (projects.length) {
    const last = [...projects].sort((a, b) => (b.id > a.id ? 1 : -1))[0]
    if (last.stages?.length) return last.stages.map(s => s.label ?? s)
  }
  return ['计划', '执行', '交付']
}

const defaultForm = () => {
  const stages = getLastStages()
  return {
    name:      '',
    client:    '',
    startDate: todayIso(),
    deadline:  weekLaterIso(),
    status:    'pending',
    color:     colorPresets[Math.floor(Math.random() * colorPresets.length)].value,
    stages,
    notes:     '',
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

const stageInputRefs = {}
async function addStage() {
  form.stages.push('')
  stageKeys.value.push(`sk${Date.now()}`)
  await nextTick()
  stageInputRefs[form.stages.length - 1]?.focus()
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
  const stages = form.stages.filter(s => s.trim()).map(s => s.trim())
  projectStore.addProject({
    name:      name,
    client:    form.client.trim(),
    startDate: form.startDate,
    deadline:  form.deadline,
    status:    form.status,
    color:     form.color,
    stages,
    notes:     form.notes.trim(),
  })
  emit('close')
}
</script>

<style scoped>
.modal { display: contents; }

/* ── 头部 ── */
.modal-header {
  display: flex; align-items: center;
  gap: 14px; padding: 0 20px 0 0; flex-shrink: 0;
  border-bottom: 1px solid rgba(0,0,0,0.07);
}
.header-color-bar {
  width: 5px; align-self: stretch; flex-shrink: 0;
  transition: background 0.2s; border-radius: 0;
}
.name-input {
  flex: 1; background: none; outline: none; border: none;
  font-size: 17px; font-weight: 700; color: var(--text-primary);
  font-family: var(--font-sans); padding: 18px 0;
  caret-color: var(--color-primary);
}
.name-input::placeholder { color: var(--text-secondary); opacity: 0.45; font-weight: 600; }
.name-input.error { color: var(--color-warning); }
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

/* ── 主体两栏 ── */
.modal-body {
  display: flex; gap: 0; flex: 1; min-height: 0; overflow: hidden;
}
.left-col {
  flex: 0 0 320px; padding: 18px 20px;
  display: flex; flex-direction: column; gap: 16px;
  overflow-y: auto;
}
.col-divider {
  border: none; border-top: 1px solid rgba(0,0,0,0.07);
  margin: 0;
}
.right-col {
  flex: 1; padding: 18px 20px;
  display: flex; flex-direction: column; gap: 16px;
  border-left: 1px solid rgba(0,0,0,0.07);
  overflow-y: auto;
}

/* ── 通用 section & field ── */
.section { display: flex; flex-direction: column; gap: 8px; }
.stages-section { flex: 1; min-height: 0; }
.field { display: flex; flex-direction: column; gap: 5px; }

label, .section-label {
  font-size: 11px; font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 7px;
}
.label-hint { font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 0.65; }

input[type="text"], input:not([type]):not(.name-input) {
  width: 100%; padding: 8px 11px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  font-size: 13px; color: var(--text-primary);
  font-family: var(--font-sans); outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  box-sizing: border-box;
}
input:not(.name-input):focus {
  border-color: rgba(123,127,178,0.4);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
input::placeholder { color: var(--text-secondary); opacity: 0.6; }

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
.status-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.s-pending .opt-dot { background: #d46b6b; }
.s-active  .opt-dot { background: #c9943a; }
.s-done    .opt-dot { background: #5a9e88; }
.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }

/* ── 颜色选择 ── */
.color-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.color-chip {
  width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, box-shadow 0.15s;
  padding: 0; outline: none;
}
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
.stages-editor { display: flex; flex-direction: column; gap: 5px; }
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
.stage-row.stage-dragging { opacity: 0.15; pointer-events: none; }
.stage-num {
  width: 20px; height: 20px; border-radius: 50%;
  background: rgba(123,127,178,0.15);
  font-size: 10px; font-weight: 700; color: var(--color-primary);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
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

/* ── 备注 ── */
.notes-input {
  width: 100%; border: 1px solid rgba(0,0,0,0.1); border-radius: 10px;
  padding: 8px 11px; font-size: 13px; font-family: var(--font-sans);
  color: var(--text-primary); background: rgba(255,255,255,0.72);
  outline: none; resize: none; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box;
}
.notes-input:focus {
  border-color: rgba(123,127,178,0.4);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
.notes-input::placeholder { color: var(--text-secondary); opacity: 0.6; }

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
