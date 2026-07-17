<template>
  <div ref="root" class="done-layout-root">
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
import { ref, onBeforeUpdate, onUpdated, toRef, type PropType, nextTick } from 'vue'
import type { Project } from '@/types/project'
import { useDoneGroups } from './useDoneGroups'
import DoneGroup from './DoneGroup.vue'
import { useDoneLayoutCoordinator } from './useDoneLayoutCoordinator'

const props = defineProps({ projects: { type: Array as PropType<Project[]>, default: () => [] } })
defineEmits(['card-click'])
const root = ref<HTMLElement | null>(null)
const initialYear = String(new Date().getFullYear())
const initialMonth = `${initialYear}${String(new Date().getMonth() + 1).padStart(2, '0')}月`
const openYears = ref(new Set<string>([initialYear]))
const openMonths = ref(new Set<string>([initialMonth]))
const { groups, recent, toggleGroup, isGroupOpen } = useDoneGroups(toRef(props, 'projects'), openYears, openMonths)
const coordinator = useDoneLayoutCoordinator()
let controlledMutationDepth = 0

function capture() { if (root.value) coordinator.capture(root.value) }
onBeforeUpdate(() => { if (!controlledMutationDepth) capture() })
onUpdated(() => {
  if (controlledMutationDepth || !root.value) return
  coordinator.measure(root.value)
  void coordinator.play()
})
async function runLayoutMutation(mutate: () => void | Promise<void>) {
  controlledMutationDepth += 1
  capture()
  try { await mutate(); await nextTick(); if (root.value) coordinator.measure(root.value); return await coordinator.play() }
  catch (error) { coordinator.cancel(); throw error }
  finally { controlledMutationDepth -= 1 }
}
async function onToggle(key: string) { await runLayoutMutation(() => toggleGroup(key)) }
defineExpose({ runLayoutMutation })
</script>
