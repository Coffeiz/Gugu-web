<template>
  <button ref="elementRef" v-bind="$attrs"><slot /></button>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  targetId: { type: String, required: true },
  surfaceId: { type: String, required: true },
  accepts: { type: Array as PropType<readonly string[]>, default: () => ['file-item', 'folder-item'] },
  priority: { type: Number, default: 1 },
})

const surfaceGeneration = runtime.surfaces.register({
  id: props.surfaceId,
  type: 'file-breadcrumb',
  layout: 'grid',
  accepts: [...props.accepts],
  element: null,
})
const elementRef = ref<HTMLElement | null>(null)
const targetGeneration = runtime.targets.register({
  id: props.targetId,
  surfaceId: props.surfaceId,
  accepts: [...props.accepts],
  priority: props.priority,
  element: null,
})
watch(() => [props.surfaceId, props.accepts] as const, ([surfaceId, accepts]) => {
  if (runtime.surfaces.get(surfaceId)?.generation === surfaceGeneration) {
    runtime.surfaces.update(surfaceId, { accepts: [...accepts] })
  }
  if (runtime.targets.get(props.targetId)?.generation === targetGeneration) {
    runtime.targets.update(props.targetId, { surfaceId, accepts: [...accepts], priority: props.priority })
  }
}, { deep: true })
watch(elementRef, (element, previous) => {
  const current = runtime.targets.get(props.targetId)
  if (current?.generation !== targetGeneration) return
  if (element === null && current.element && current.element !== previous) return
  runtime.targets.setElement(props.targetId, element)
}, { flush: 'post' })
onUnmounted(() => {
  if (runtime.targets.get(props.targetId)?.generation === targetGeneration) runtime.targets.unregister(props.targetId, targetGeneration)
  if (runtime.surfaces.get(props.surfaceId)?.generation === surfaceGeneration) runtime.surfaces.unregister(props.surfaceId, surfaceGeneration)
})
</script>
