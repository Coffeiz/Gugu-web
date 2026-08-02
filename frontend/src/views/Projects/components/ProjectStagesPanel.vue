<template>
  <div class="section stages-section">
    <div class="stages-header">
      <label class="section-label">项目阶段 <span class="label-hint">拖拽排序</span></label>
      <button class="add-stage-btn" @click="handleAddStage">＋ 添加</button>
    </div>
    <div class="stage-flow" ref="stageFlowRef">
      <TransitionGroup name="stage-flip">
        <div
          v-for="(stage, i) in displayStages" :key="stage.key"
          class="stage-node"
          :class="{
            active: i === activeStageIdx && stage.key !== draggedStageKey,
            done: i < activeStageIdx && stage.key !== draggedStageKey,
            locked: lockedStageIndices.has(localStages.findIndex(s => s.key === stage.key)),
            'stage-dragging': stageDrag.active && stage.key === draggedStageKey,
            expanded: expandedStages.has(stage.key),
          }"
        >
          <!-- 节点行 -->
          <div class="node-row" @mousedown="editingStage !== stage.key && startStageDrag(i, $event)">
            <div class="node-circle"
              :style="i === activeStageIdx && stage.key !== draggedStageKey ? { background: stageColor } : {}"
              @click.stop="!stageDrag.active && handleSetStage(stage.key, i)"
            >
              <PhCheck v-if="i < activeStageIdx && stage.key !== draggedStageKey" :size="10" weight="bold" style="color:white" />
              <span v-else class="node-num">{{ i + 1 }}</span>
            </div>
            <div class="node-body">
              <input
                v-if="editingStage === stage.key"
                v-model="stage.label"
                class="stage-input"
                @blur="handleSaveStages" v-enter="handleSaveStages" @keydown.esc="editingStage = null" @click.stop
                ref="stageInputRef"
              />
              <span v-else class="node-label" @click.stop="startEdit(stage.key)">{{ stage.label }}</span>
              <span class="todo-count" v-if="stage.todos?.length">{{ stage.todos.filter(t=>t.done).length }}/{{ stage.todos.length }}</span>
            </div>
            <button class="del-stage" @click.stop="handleRemoveStage(stage.key)">
              <PhX :size="9" weight="bold" />
            </button>
          </div>
          <!-- 待办列表 -->
          <ProjectTodosPanel
            :stage="stage"
            :is-last="i === displayStages.length - 1"
            :editing-todo="editingTodo"
            :dragging="todoDrag"
            @list-dragover="todoListDragOver"
            @drag-start="todoDragStart"
            @drag-end="todoDragEnd"
            @drag-over="todoDragOver"
            @toggle="handleToggleTodo"
            @start-edit="startEditTodo"
            @finish-edit="projectTodos.stopEditing"
            @save="handleSaveTodos"
            @remove="handleRemoveTodo"
            @add="handleAddTodo"
          />
        </div>
      </TransitionGroup>
    </div>

    <!-- 拖拽虚影 -->
    <Teleport to="body">
      <div v-if="stageDrag.active" class="stage-drag-ghost-full"
        :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
        <span class="node-label">{{ stageDrag.ghostLabel }}</span>
        <div v-if="stageDrag.ghostTodos.length" class="ghost-todos">
          <div v-for="t in stageDrag.ghostTodos" :key="t.id" class="ghost-todo" :class="{ done: t.done }">{{ t.text || '待办事项' }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, watch, onUnmounted, type PropType } from 'vue'
import { PhCheck, PhX } from '@phosphor-icons/vue'
import type { ProjectStage, ProjectTodo } from '@/types/project'
import { useProjectStages } from '@/composables/projects/useProjectStages'
import { useProjectTodos } from '@/composables/projects/useProjectTodos'
import ProjectTodosPanel from './ProjectTodosPanel.vue'

const props = defineProps({
  stages: { type: Array as PropType<ProjectStage[]>, required: true },
  currentStage: { type: String, required: true },
  stageColor: { type: String, default: '' },
  onSaveStages: { type: Function, required: true },
  onSaveTodos: { type: Function, required: true },
  onSetStage: { type: Function, required: true },
})

const emit = defineEmits<{
  'update:stages': [stages: ProjectStage[]]
  'update:currentStage': [key: string]
}>()

// 本地副本，同步 props 初始值
const localStages = ref<ProjectStage[]>([])
watch(() => props.stages, (v) => {
  localStages.value = v.map(s => ({ ...s, todos: s.todos?.map(t => ({ ...t })) ?? [] }))
}, { immediate: true })

// 通过 useProjectStages 复用阶段/待办操作编排
const projectStages = useProjectStages({
    stages: localStages,
    saveStages: () => handleSaveStages(),
  })
const projectTodos = useProjectTodos({
  stages: localStages,
  currentStage: () => props.currentStage,
  saveTodos: () => handleSaveTodos(),
  setStage: (key, index) => handleSetStage(key, index),
})

const activeStageIdx = computed(() =>
  localStages.value.findIndex(s => s.key === props.currentStage))

const displayStages = computed(() => {
  const stages = localStages.value
  if (!stageDrag.active || stageDrag.fromIdx === -1) return stages
  const copy = [...stages]
  const [moved] = copy.splice(stageDrag.fromIdx, 1)
  copy.splice(stageDrag.toIdx, 0, moved)
  return copy
})

const lockedStageIndices = computed(() => {
  return projectStages.lockedStageIndices(props.currentStage)
})

// 编辑态
const editingStage = ref<string | null>(null)
const editingTodo = projectTodos.editingTodo
const expandedStages = ref(new Set<string>())
const stageInputRef = ref<HTMLInputElement | null>(null)
const stageFlowRef = ref<HTMLElement | null>(null)

const todoDrag = ref<{ stageKey: string; index: number } | null>(null)

// ── 阶段拖拽 ──
interface StageDragState {
  active: boolean
  fromIdx: number
  toIdx: number
  ghostX: number
  ghostY: number
  ghostWidth: number
  ghostLabel: string
  ghostTodos: ProjectTodo[]
}
const stageDrag = reactive<StageDragState>({
  active: false, fromIdx: -1, toIdx: -1,
  ghostX: 0, ghostY: 0, ghostWidth: 0, ghostLabel: '', ghostTodos: [],
})
const draggedStageKey = computed(() =>
  stageDrag.fromIdx >= 0 ? localStages.value[stageDrag.fromIdx]?.key : null)
let stopStageDrag: (() => void) | null = null

function stageIdxFromY(y: number) {
  if (!stageFlowRef.value) return stageDrag.toIdx
  const nodes = stageFlowRef.value.querySelectorAll('.stage-node')
  let current = stageDrag.toIdx
  if (current < 0) current = 0
  if (current > 0) {
    const previous = nodes[current - 1]?.getBoundingClientRect()
    if (previous && y < previous.top + previous.height / 2) return current - 1
  }
  if (current < nodes.length - 1) {
    const next = nodes[current + 1]?.getBoundingClientRect()
    if (next && y > next.top + next.height / 2) return current + 1
  }
  return current
}

function startStageDrag(i: number, e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.currentTarget as HTMLElement | null
  if (!target) return
  const startX = e.clientX
  const startY = e.clientY
  const rect = target.getBoundingClientRect()
  const stage = localStages.value[i]
  if (!stage) return
  let activated = false

  const onMove = (me: MouseEvent) => {
    if (!activated) {
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 4) return
      activated = true
      stageDrag.active = true
      stageDrag.fromIdx = i
      stageDrag.toIdx = i
      stageDrag.ghostWidth = rect.width
      stageDrag.ghostLabel = stage.label
      stageDrag.ghostTodos = [...(stage.todos ?? [])]
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    }
    stageDrag.ghostX = me.clientX - (startX - rect.left)
    stageDrag.ghostY = me.clientY - (startY - rect.top)
    if (!stageFlowRef.value) return
    stageDrag.toIdx = stageIdxFromY(me.clientY)
  }
  const onUp = () => {
    if (activated) {
      if (stageDrag.toIdx !== stageDrag.fromIdx) {
      const copy = [...localStages.value]
      const [moved] = copy.splice(stageDrag.fromIdx, 1)
      copy.splice(stageDrag.toIdx, 0, moved)
      localStages.value = copy
      emit('update:stages', copy)
      props.onSaveStages()
      }
      stageDrag.active = false
      stageDrag.fromIdx = -1
      stageDrag.toIdx = -1
    }
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    stopStageDrag = null
  }
  stopStageDrag = onUp
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onUnmounted(() => stopStageDrag?.())

// ── 待办拖拽 ──
function todoDragStart(stage: ProjectStage, ti: number) {
  todoDrag.value = { stageKey: stage.key, index: ti }
}
function todoDragEnd() {
  if (todoDrag.value) {
    todoDrag.value = null
    handleSaveStages()
  }
}
function todoListDragOver(stage: ProjectStage) {
  if (!todoDrag.value || todoDrag.value.stageKey === stage.key) return
  const todo = localStages.value
    .find(s => s.key === todoDrag.value!.stageKey)
    ?.todos?.splice(todoDrag.value!.index, 1)[0]
  if (!todo) return
  if (!stage.todos) stage.todos = []
  stage.todos.unshift(todo)
  todoDrag.value = { stageKey: stage.key, index: 0 }
}
function todoDragOver(stage: ProjectStage, ti: number, e: DragEvent) {
  if (!todoDrag.value) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const after = e.clientY > rect.top + rect.height / 2
  const targetStage = localStages.value.find(s => s.key === todoDrag.value!.stageKey)
  if (!targetStage) return
  const fromIdx = todoDrag.value.index
  let targetIndex = after ? ti + 1 : ti
  if (stage.key === targetStage.key && fromIdx < targetIndex) targetIndex -= 1
  if (stage.key === targetStage.key && targetIndex === fromIdx) return
  const [todo] = targetStage.todos!.splice(fromIdx, 1)
  if (!todo) return
  if (!stage.todos) stage.todos = []
  targetIndex = Math.max(0, Math.min(targetIndex, stage.todos.length))
  stage.todos.splice(targetIndex, 0, todo)
  todoDrag.value = { stageKey: stage.key, index: targetIndex }
}

// ── 编辑 ──
function startEdit(stageKey: string) {
  editingStage.value = stageKey
  nextTick(() => stageInputRef.value?.focus())
}
function startEditTodo(todoId: string) {
  projectTodos.startEditing(todoId)
  nextTick(() => {
    const input = document.querySelector(`[data-tid="${todoId}"]`) as HTMLInputElement | null
    input?.focus()
  })
}

// ── 操作包装（调用父级回调） ──
function handleAddStage() {
  const key = projectStages.addStage()
  nextTick(() => startEdit(key))
}
function handleRemoveStage(key: string) {
  if (projectStages.removeStage(key)) expandedStages.value.delete(key)
}
function handleSetStage(key: string, idx: number) {
  props.onSetStage(key, idx)
}
function handleSaveStages() {
  editingStage.value = null
  emit('update:stages', localStages.value)
  props.onSaveStages()
}
function handleSaveTodos() {
  emit('update:stages', localStages.value)
  props.onSaveTodos()
}
function handleAddTodo(stage: ProjectStage) {
  projectTodos.addTodo(stage)
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLElement>(`.todo-input-${stage.key}`)
    inputs[inputs.length - 1]?.focus()
  })
}
function handleRemoveTodo(stage: ProjectStage, id: string) {
  projectTodos.removeTodo(stage, id)
}
function handleToggleTodo(todo: ProjectTodo) {
  // 阶段推进已经保存了包含本次勾选的完整草稿，普通勾选才需要单独保存。
  if (!projectTodos.toggleTodo(todo)) handleSaveTodos()
}
</script>

<style scoped>
/* 阶段 */
.stages-section { flex: 1; min-height: 80px; display: flex; flex-direction: column; gap: 0; padding-bottom: 0; }
.stages-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;
}
.add-stage-btn {
  background: none; border: none; font-size: 11px; font-weight: 600;
  color: var(--color-primary); cursor: pointer; font-family: var(--font-sans);
  padding: 0; text-transform: none; letter-spacing: 0;
}
.add-stage-btn:hover { opacity: 0.7; }
.stage-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 2px 11px 4px 8px; margin-right: -3px; }
.stage-flow::-webkit-scrollbar { width: 3px; }
.stage-flow::-webkit-scrollbar-track { background: transparent; }
.stage-flow::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }

.stage-node { display: flex; flex-direction: column; position: relative; cursor: grab; transition: opacity 0.15s; padding: 0 0 0 5px; margin-bottom: 2px; }
.stage-node.stage-dragging { opacity: 0.15; pointer-events: none; transition: none; }

.node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 0; }
.node-circle {
  width: 22px; height: 22px; border-radius: 50%;
  border: 1.5px solid rgba(90,95,120,0.35); background: rgba(0,0,0,0.08);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  cursor: pointer; z-index: 1;
}
.stage-node.done .node-circle { background: var(--color-success); border-color: var(--color-success); }
.stage-node.active .node-circle { border-color: transparent; }
.stage-node.locked .node-circle { cursor: not-allowed; opacity: 0.7; }
.stage-node.locked .node-label  { opacity: 0.6; }
.node-num { font-size: 10px; font-weight: 700; color: #5a5f78; line-height: 1; }
.stage-node.active .node-num { color: #fff; }
.node-body { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-label { font-size: 13px; color: var(--text-primary); }
.stage-node.done .node-label { color: var(--text-secondary); text-decoration: line-through; }
.stage-node.active .node-label { font-weight: 600; }
.todo-count { font-size: 10px; color: var(--text-secondary); opacity: 0.7; white-space: nowrap; }
.stage-input {
  font-size: 13px; font-family: var(--font-sans);
  border: 1px solid rgba(123,127,178,0.4); border-radius: 6px; padding: 1px 6px;
  background: rgba(255,255,255,0.5); outline: none; color: var(--text-primary); width: 110px;
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
  transition: background 0.15s;
}
.stage-input:hover, .stage-input:focus { background: rgba(255,255,255,0.75); }
.del-stage {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 2px;
  display: flex; align-items: center; flex-shrink: 0;
}
.stage-node:hover .del-stage { opacity: 0.5; }
.del-stage:hover { opacity: 1 !important; color: var(--color-warning); }
</style>
