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
import { ref, onBeforeUpdate, onUpdated, onBeforeUnmount, provide, toRef, type PropType } from 'vue'
import type { Project } from '@/types/project'
import { useDoneGroups } from './useDoneGroups'
import DoneGroup from './DoneGroup.vue'
import { useDoneLayoutRuntime } from './useDoneLayoutRuntime'
import { doneGroupHeightKey, doneLayoutMutationKey } from './doneLayoutBridge'

const props = defineProps({ projects: { type: Array as PropType<Project[]>, default: () => [] } })
defineEmits(['card-click'])
const root = ref<HTMLElement | null>(null)
const initialYear = String(new Date().getFullYear())
const initialMonth = `${initialYear}${String(new Date().getMonth() + 1).padStart(2, '0')}月`
const openYears = ref(new Set<string>([initialYear]))
const openMonths = ref(new Set<string>([initialMonth]))
const { groups, recent, toggleGroup, isGroupOpen } = useDoneGroups(toRef(props, 'projects'), openYears, openMonths)
const coordinator = useDoneLayoutRuntime()

function releaseRecentEntries() {
  if (!root.value) return
  root.value.querySelectorAll<HTMLElement>('[data-recent-enter="true"]').forEach((element) => {
    const key = element.dataset.layoutKey || ''
    const placeholder = root.value?.querySelector<HTMLElement>(`.recent-enter-placeholder[data-placeholder-for="${key}"]`)
    element.style.position = ''
    element.style.left = ''
    element.style.right = ''
    element.style.width = ''
    element.style.pointerEvents = ''
    // 占位与真实卡片必须在同一轮 DOM 写入中交接。先删占位再回流真实卡会让
    // recent 容器短暂收缩，迫使年组先跳一次，随后又被卡片撑回去。
    placeholder?.replaceWith(element)
    void element.offsetWidth
    element.style.transition = 'opacity .34s cubic-bezier(.22,1,.36,1)'
    element.style.opacity = '1'
    delete element.dataset.recentEnter
  })
}

function capture() { if (root.value) coordinator.capture(root.value) }
onBeforeUpdate(() => {
  if (!coordinator.isControlled() && root.value) coordinator.capture(root.value)
})
onUpdated(() => {
  if (coordinator.isControlled() || !root.value) return
  // 必须在 Vue 更新后的同一帧写入 FLIP inverse；延到下一帧会先暴露一次
  // 原生布局位置，表现为年组瞬间下移后才开始动画。
  coordinator.measure(root.value)
  void coordinator.play(releaseRecentEntries)
})
onBeforeUnmount(() => {
  coordinator.cancel()
})
async function runLayoutMutation(mutate: () => void | Promise<void>) {
  return await coordinator.runLayoutMutation(mutate, releaseRecentEntries)
}
async function onToggle(key: string) { await runLayoutMutation(() => toggleGroup(key)) }
provide(doneLayoutMutationKey, runLayoutMutation)
provide(doneGroupHeightKey, coordinator.playGroupHeight)
defineExpose({ runLayoutMutation })
</script>
