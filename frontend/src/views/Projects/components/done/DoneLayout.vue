<template>
  <div class="done-layout-root">
    <div v-if="!groups.length" class="col-empty">拖拽项目到此</div>
    <template v-else>
      <DoneGroup v-if="recent.items.length" :group="recent" @card-click="$emit('card-click', $event)" />
      <template v-for="group in groups" :key="group.key">
        <DoneGroup v-if="group.type === 'year'" :group="group" @toggle="onToggle" />
        <template v-if="group.type === 'year' && group.open">
          <DoneGroup v-for="month in group.children" :key="month.key" :group="month" :is-undated-open="false" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
        </template>
        <DoneGroup v-if="group.type === 'undated'" :group="group" :is-undated-open="isGroupOpen('__undated')" @toggle="onToggle" @card-click="$emit('card-click', $event)" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, toRef, type PropType } from 'vue'
import type { Project } from '@/types/project'
import { useDoneGroups } from './useDoneGroups'
import DoneGroup from './DoneGroup.vue'

const props = defineProps({ projects: { type: Array as PropType<Project[]>, default: () => [] } })
defineEmits(['card-click'])
const initialYear = String(new Date().getFullYear())
const initialMonth = `${initialYear}${String(new Date().getMonth() + 1).padStart(2, '0')}月`
const openYears = ref(new Set<string>([initialYear]))
const openMonths = ref(new Set<string>([initialMonth]))
const { groups, recent, toggleGroup, isGroupOpen } = useDoneGroups(toRef(props, 'projects'), openYears, openMonths)
function onToggle(key: string) {
  toggleGroup(key)
}
</script>
