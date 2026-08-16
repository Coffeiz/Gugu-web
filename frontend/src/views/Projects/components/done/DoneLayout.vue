<template>
  <div ref="layoutRoot" class="done-layout-root">
    <div v-if="!groups.length" class="col-empty">拖拽项目到此</div>
    <template v-else>
      <DoneGroup v-if="recent.items.length" v-memo="groupMemo(recent)" :group="recent" :ownership-version="ownershipVersionFor(recent.items)" :is-project-detached="isProjectDetached" @card-click="$emit('card-click', $event)" />
      <template v-for="group in groups" :key="group.key">
        <DoneGroup v-if="group.type === 'year'" v-memo="groupMemo(group)" :group="group" :ownership-version="0" :is-project-detached="isProjectDetached" @toggle="onToggle" />
        <div v-if="group.type === 'year'" class="year-folder" :data-layout-key="group.key" data-layout-content :data-layout-open="group.open ? 'true' : 'false'">
          <DoneGroup v-for="month in group.children" :key="month.key" v-memo="groupMemo(month)" :group="month" :ownership-version="ownershipVersionFor(month.items)" :is-project-detached="isProjectDetached" :is-undated-open="false" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
        </div>
        <DoneGroup v-if="group.type === 'undated'" v-memo="groupMemo(group, isGroupOpen('__undated'))" :group="group" :ownership-version="ownershipVersionFor(group.items)" :is-project-detached="isProjectDetached" :is-undated-open="isGroupOpen('__undated')" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, type PropType } from 'vue'
import type { Project } from '@/types/project'
import { runtime } from '@/interaction/runtime'
import { useDoneGroups } from './useDoneGroups'
import DoneGroup from './DoneGroup.vue'
import type { DoneGroup as DoneGroupModel } from './doneTypes'

const props = defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  ownershipVersionFor: { type: Function as PropType<(projects: Project[]) => number>, required: true },
  isProjectDetached: { type: Function as PropType<(projectId: string) => boolean>, required: true },
})
defineEmits(['card-click'])
const initialYear = String(new Date().getFullYear())
const initialMonth = `${initialYear}${String(new Date().getMonth() + 1).padStart(2, '0')}月`
const openYears = ref(new Set<string>([initialYear]))
const openMonths = ref(new Set<string>([initialMonth]))
const { groups, recent, toggleGroup, isGroupOpen } = useDoneGroups(toRef(props, 'projects'), openYears, openMonths)
const ownershipVersionFor = props.ownershipVersionFor
const layoutRoot = ref<HTMLElement | null>(null)

// 分组对象每次 projects 更新都会重新创建；只让结构或卡片展示字段实际变化的组进入 patch。
function groupMemo(group: DoneGroupModel, openOverride?: boolean): unknown[] {
  if (group.type === 'year') {
    return [group.key, group.open, group.children.reduce((total, child) => total + child.items.length, 0)]
  }
  return [
    group.key,
    group.type,
    'open' in group ? group.open : openOverride,
    ...group.items.flatMap(project => [
      project.id,
      project.status,
      project.currentStage,
      project.progress,
      project.stages,
      project.doneAt,
      project._stageBeforeDone,
      project.fileCount,
      project.priority,
      project.name,
      project.client,
      project.color,
      project.startDate,
      project.deadline,
      project.version,
    ]),
  ]
}

async function onToggle(key: string) {
  const stateKey = key.startsWith('year-') ? key.slice(5) : key
  const content = layoutRoot.value?.querySelector<HTMLElement>(
    `[data-layout-key="${CSS.escape(key)}"].month-folder, [data-layout-key="${CSS.escape(key)}"] .month-folder, [data-layout-key="${CSS.escape(key)}"].year-folder`,
  )
  const opening = !isGroupOpen(stateKey)
  if (!content || !layoutRoot.value) return
  await runtime.runGroupToggle({
    root: layoutRoot.value,
    content,
    opening,
    mutate: () => toggleGroup(key),
    waitForLayout: nextTick,
    duration: 250,
    easing: 'cubic-bezier(.22,1,.36,1)',
  })
}
</script>
