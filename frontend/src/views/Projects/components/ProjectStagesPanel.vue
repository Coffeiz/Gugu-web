<template>
  <div class="section stages-section">
    <div class="stages-header">
      <label class="section-label">项目阶段 <span class="label-hint">拖拽排序</span></label>
      <button class="add-stage-btn" @click="handleAddStage">＋ 添加</button>
    </div>
    <div class="stage-flow scroll-surface scroll-surface--compact" ref="stageFlowRef">
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
          <div class="node-row" @mousedown="editingStage !== stage.key && startStageDrag(i, $event)">
            <div class="node-circle"
              :style="i === activeStageIdx && stage.key !== draggedStageKey ? { background: stageColor } : {}"
              @click.stop="!stageDrag.active && handleSetStage(stage.key, i)"
            >
              <Icon name="status.success" v-if="i < activeStageIdx && stage.key !== draggedStageKey" :size="10" style="color:white" />
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
              <Icon name="action.close" :size="9" />
            </button>
          </div>
          <ProjectTodosPanel
            :stage="stage"
            :is-last="i === displayStages.length - 1"
            :editing-todo="editingTodo ?? undefined"
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
import Icon from '@/components/common/Icon.vue'
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

const localStages = ref<ProjectStage[]>([])
watch(() => props.stages, (v) => {
  localStages.value = v.map(s => ({ ...s, todos: s.todos?.map(t => ({ ...t })) ?? [] }))
}, { immediate: true })

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

const editingStage = ref<string | null>(null)
const editingTodo = projectTodos.editingTodo
const expandedStages = ref(new Set<string>())
const stageInputRef = ref<HTMLInputElement | null>(null)
const stageFlowRef = ref<HTMLElement | null>(null)

const todoDrag = ref<{ stageKey: string; index: number } | null>(null)

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
  if (!projectTodos.toggleTodo(todo)) handleSaveTodos()
}
</script>

<style scoped>
.stages-section { flex: 1; min-height: 80px; display: flex; flex-direction: column; gap: 0; padding-bottom: 0; }
.stages-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
/* ProjectInfoPanel's .section-label is scoped to that component, so stages must own the same
   typography instead of accidentally falling back to browser <label> styling. */
.stages-header .section-label {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 10px; font-weight: 600; color: var(--content-secondary);
  text-transform: uppercase; letter-spacing: .07em;
}
.stages-header .label-hint {
  font-size: 10px; font-weight: 400; color: var(--content-tertiary);
  text-transform: none; letter-spacing: 0;
}
.add-stage-btn {
  background: none; border: none; padding: 0; cursor: pointer;
  font: 600 11px var(--font-sans); color: var(--action-primary);
  text-transform: none; letter-spacing: 0;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), opacity var(--motion-hover-control) var(--motion-ease-standard);
}
.add-stage-btn:hover { color: var(--action-primary-hover); opacity: .78; }
.stage-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 2px 11px 4px 8px; margin-right: -3px; }
.stage-node { display: flex; flex-direction: column; position: relative; cursor: grab; transition: opacity var(--motion-hover-control) var(--motion-ease-standard); padding: 0 0 0 5px; margin-bottom: 2px; }
.stage-node.stage-dragging { opacity: .15; pointer-events: none; transition: none; }
.node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 0; }
.node-circle {
  width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0; cursor: pointer; z-index: 1;
  border: 1.5px solid var(--option-border); background: var(--option-bg);
  display: flex; align-items: center; justify-content: center;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.stage-node.done .node-circle { background: var(--status-success); border-color: var(--status-success); }
.stage-node.active .node-circle { border-color: transparent; }
.stage-node.locked .node-circle { cursor: not-allowed; opacity: .7; }
.stage-node.locked .node-label { opacity: .6; }
.node-num { font-size: 10px; font-weight: 700; color: var(--content-secondary); line-height: 1; }
.stage-node.active .node-num { color: var(--content-on-accent); }
.node-body { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-label { font-size: 13px; color: var(--content-primary); }
.stage-node.done .node-label { color: var(--content-secondary); text-decoration: line-through; }
.stage-node.active .node-label { font-weight: 600; }
.todo-count { font-size: 10px; color: var(--content-tertiary); white-space: nowrap; }
.stage-input {
  width: 110px; padding: 1px 6px; border-radius: var(--radius-xs); outline: none;
  font: 13px var(--font-sans); color: var(--input-fg); background: var(--input-bg-focus);
  border: 1px solid var(--input-border-focus); box-shadow: var(--input-focus-shadow);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.stage-input:hover,
.stage-input:focus { background: var(--input-bg-focus); border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); }
.del-stage {
  display: flex; align-items: center; flex-shrink: 0; padding: 2px;
  background: none; border: none; cursor: pointer; color: var(--content-tertiary); opacity: 0;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.stage-node:hover .del-stage { opacity: .5; }
.del-stage:hover { opacity: 1 !important; color: var(--danger-button-fg); }
</style>
