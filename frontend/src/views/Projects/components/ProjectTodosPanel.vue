<template>
  <div class="todo-list" :class="{ 'is-last': isLast }"
    @dragover.prevent="emit('list-dragover', stage)" @drop="emit('drag-end')">
    <TransitionGroup tag="div" name="todo-flip" class="todo-items">
      <div v-for="(todo, ti) in (stage.todos ?? [])" :key="todo.id" class="todo-item"
        :class="{ 'todo-ghost': dragging && dragging.stageKey === stage.key && dragging.index === ti }"
        :draggable="editingTodo !== todo.id"
        @dragstart="emit('drag-start', stage, ti)" @dragend="emit('drag-end')"
        @dragover.prevent.stop="emit('drag-over', stage, ti, $event)">
        <button class="todo-check" :class="{ checked: todo.done }" @click.stop="emit('toggle', todo)">
          <PhCheck v-if="todo.done" :size="9" weight="bold" />
        </button>
        <input v-if="editingTodo === todo.id" :class="['todo-input', `todo-input-${stage.key}`]"
          :data-tid="todo.id" v-model="todo.text" :title="todo.text"
          :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
          placeholder="待办事项" @blur="emit('finish-edit'); emit('save')"
          v-enter.prevent="() => (emit('finish-edit'), emit('save'))"
          @keydown.esc="emit('finish-edit')" @keydown.backspace="!todo.text && emit('remove', stage, todo.id)" />
        <span v-else class="todo-name" :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
          @click.stop="emit('start-edit', todo.id)">{{ todo.text || '待办事项' }}</span>
        <button class="todo-del" @click.stop="emit('remove', stage, todo.id)"><PhX :size="8" weight="bold" /></button>
      </div>
    </TransitionGroup>
    <button class="todo-add-btn" @click.stop="emit('add', stage)">＋ 添加待办</button>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCheck, PhX } from '@phosphor-icons/vue'
import type { ProjectStage, ProjectTodo } from '@/types/project'

defineProps({
  stage: { type: Object as PropType<ProjectStage>, required: true },
  isLast: { type: Boolean, default: false },
  editingTodo: { type: String, default: null },
  dragging: { type: Object as PropType<{ stageKey: string; index: number } | null>, default: null },
})
const emit = defineEmits<{
  'list-dragover': [stage: ProjectStage]
  'drag-start': [stage: ProjectStage, index: number]
  'drag-end': []
  'drag-over': [stage: ProjectStage, index: number, event: DragEvent]
  'toggle': [todo: ProjectTodo]
  'start-edit': [id: string]
  'finish-edit': []
  'save': []
  'remove': [stage: ProjectStage, id: string]
  'add': [stage: ProjectStage]
}>()
</script>

<style scoped>
.todo-list { padding: 2px 0 8px 30px; display: flex; flex-direction: column; gap: 3px; background-image: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.06) 20%, rgba(0,0,0,0.06) 80%, transparent 100%); background-size: 100% 1px; background-repeat: no-repeat; background-position: center bottom; }
.todo-list.is-last { background-image: none; }
.todo-items { display: flex; flex-direction: column; gap: 3px; }
.todo-item { display: flex; align-items: flex-start; gap: 6px; min-height: 24px; }
.todo-item + .todo-item { border-top: 1px solid rgba(0,0,0,0.05); }
.todo-check, .todo-del { margin-top: 4px; }
.todo-name { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--text-primary); padding: 2px 0; cursor: grab; overflow-wrap: break-word; word-break: break-word; white-space: normal; }
.todo-item:active .todo-name { cursor: grabbing; }
.todo-ghost { opacity: 0.35; }
.todo-check { width: 15px; height: 15px; border-radius: 4px; flex-shrink: 0; border: 1.5px solid rgba(0,0,0,0.18); background: rgba(255,255,255,0.7); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.todo-check.checked { background: var(--color-success); border-color: var(--color-success); color: white; }
.todo-input { flex: 1; font-size: 12px; font-family: var(--font-sans); color: var(--text-primary); border: 1.5px solid transparent; border-radius: 5px; background: transparent; outline: none; min-width: 0; padding: 0 5px; box-sizing: border-box; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s; }
.todo-input:focus { background: rgba(255,255,255,0.72); border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.todo-del { background: none; border: none; cursor: pointer; color: var(--text-secondary); opacity: 0; transition: opacity 0.15s; padding: 2px; display: flex; align-items: center; flex-shrink: 0; }
.todo-item:hover .todo-del { opacity: 0.4; }
.todo-del:hover { opacity: 1 !important; color: var(--color-warning); }
.todo-add-btn { display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 10px; border-radius: 7px; border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.62); font-size: 11px; font-weight: 500; color: var(--text-secondary); cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; margin-top: 2px; margin-right: 18px; }
.todo-add-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(255,255,255,0.75); }
</style>
