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
.todo-list {
  padding: 2px 0 8px 30px; display: flex; flex-direction: column; gap: 3px;
  background-image: linear-gradient(90deg,transparent 0%,var(--panel-divider) 20%,var(--panel-divider) 80%,transparent 100%);
  background-size: 100% 1px; background-repeat: no-repeat; background-position: center bottom;
}
.todo-list.is-last { background-image: none; }
.todo-items { display: flex; flex-direction: column; gap: 3px; }
.todo-item { display: flex; align-items: flex-start; gap: 6px; min-height: 24px; }
.todo-item + .todo-item { border-top: 1px solid var(--panel-divider); }
.todo-check, .todo-del { margin-top: 4px; }
.todo-name {
  flex: 1; min-width: 0; padding: 2px 0; cursor: grab;
  font-size: 12px; line-height: 1.5; color: var(--content-primary);
  overflow-wrap: break-word; word-break: break-word; white-space: normal;
}
.todo-item:active .todo-name { cursor: grabbing; }
.todo-ghost { opacity: .35; }
.todo-check {
  width: 15px; height: 15px; border-radius: 4px; flex-shrink: 0;
  border: 1.5px solid var(--option-border); background: var(--option-bg);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.todo-check.checked { background: var(--status-success); border-color: var(--status-success); color: var(--content-on-accent); }
.todo-input {
  flex: 1; min-width: 0; padding: 0 5px; box-sizing: border-box;
  font: 12px var(--font-sans); color: var(--input-fg); background: transparent;
  border: 1.5px solid transparent; border-radius: var(--radius-xs); outline: none;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.todo-input:focus { background: var(--input-bg-focus); border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); }
.todo-input::placeholder { color: var(--input-placeholder); }
.todo-del {
  display: flex; align-items: center; flex-shrink: 0; padding: 2px;
  background: none; border: none; cursor: pointer; color: var(--content-tertiary); opacity: 0;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.todo-item:hover .todo-del { opacity: .4; }
.todo-del:hover { opacity: 1 !important; color: var(--danger-button-fg); }
.todo-add-btn {
  display: flex; align-items: center; gap: 4px; height: 24px; margin-top: 2px; margin-right: 18px;
  padding: 0 10px; border-radius: var(--radius-xs); border: 1px dashed var(--option-border);
  background: var(--option-bg); color: var(--option-fg);
  font: 500 11px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.todo-add-btn:hover { border-color: var(--option-border-hover); color: var(--action-primary); background: var(--option-bg-hover); }
</style>
