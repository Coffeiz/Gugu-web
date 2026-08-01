<template>
  <div ref="layoutRoot" class="done-layout-root">
    <div v-if="!groups.length" class="col-empty">拖拽项目到此</div>
    <template v-else>
      <DoneGroup v-if="recent.items.length" :group="recent" @card-click="$emit('card-click', $event)" />
      <template v-for="group in groups" :key="group.key">
        <DoneGroup v-if="group.type === 'year'" :group="group" @toggle="onToggle" />
        <div v-if="group.type === 'year'" class="year-folder" :data-layout-key="group.key" data-layout-content :data-layout-open="group.open ? 'true' : 'false'">
          <DoneGroup v-for="month in group.children" :key="month.key" :group="month" :is-undated-open="false" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
        </div>
        <DoneGroup v-if="group.type === 'undated'" :group="group" :is-undated-open="isGroupOpen('__undated')" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, type PropType } from 'vue'
import type { Project } from '@/types/project'
import { transitionGroupHeight } from '@/interaction/runtime'
import { useDoneGroups } from './useDoneGroups'
import DoneGroup from './DoneGroup.vue'

const props = defineProps({ projects: { type: Array as PropType<Project[]>, default: () => [] } })
defineEmits(['card-click'])
const initialYear = String(new Date().getFullYear())
const initialMonth = `${initialYear}${String(new Date().getMonth() + 1).padStart(2, '0')}月`
const openYears = ref(new Set<string>([initialYear]))
const openMonths = ref(new Set<string>([initialMonth]))
const { groups, recent, toggleGroup, isGroupOpen } = useDoneGroups(toRef(props, 'projects'), openYears, openMonths)
const layoutRoot = ref<HTMLElement | null>(null)
let toggleToken = 0
async function onToggle(key: string) {
  const content = layoutRoot.value?.querySelector<HTMLElement>(
    `[data-layout-key="${CSS.escape(key)}"].month-folder, [data-layout-key="${CSS.escape(key)}"] .month-folder, [data-layout-key="${CSS.escape(key)}"].year-folder`,
  )
  const stateKey = key.startsWith('year-') ? key.slice(5) : key
  const opening = !isGroupOpen(stateKey)
  const current = content?.getBoundingClientRect().height ?? 0
  const token = ++toggleToken
  toggleGroup(key)
  if (!content) return
  await nextTick()
  if (token !== toggleToken) return
  transitionGroupHeight(content, opening ? content.scrollHeight : 0, 250, 'cubic-bezier(.22,1,.36,1)', current)
}
</script>
