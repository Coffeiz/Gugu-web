<template>
  <div ref="elementRef" v-bind="$attrs"><slot /></div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime, bindRuntimeObjectPointer, type TargetItem } from '@/interaction/runtime'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, required: true },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] },
  runtimeSelected: { type: Boolean, default: false },
  runtimeTarget: { type: Object as PropType<Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined>, default: undefined },
})

const targetSurfaceId = props.runtimeTarget?.surfaceId ?? `${props.runtimeId}:surface`
const targetSurfaceGeneration = runtime.surfaces.register({ id: targetSurfaceId, type: 'file-folder', layout: 'grid', accepts: ['file-item', 'folder-item'], element: null })
const elementRef = ref<HTMLElement | null>(null)
const generation = runtime.objects.register({
  id: props.runtimeId,
  type: props.runtimeType,
  surfaceId: props.runtimeSurfaceId,
  abilities: [...props.runtimeAbilities],
  selected: props.runtimeSelected,
  target: props.runtimeTarget,
  element: null,
})
let stopPointerBinding: (() => void) | null = null
watch(() => [props.runtimeType, props.runtimeSurfaceId, props.runtimeAbilities, props.runtimeSelected, props.runtimeTarget] as const, ([type, surfaceId, abilities, selected, target]) => {
  if (runtime.objects.get(props.runtimeId)?.generation !== generation) return
  runtime.objects.update(props.runtimeId, { type, surfaceId, abilities: [...abilities], selected, target })
}, { deep: true })
watch(elementRef, (element, previous) => {
  const current = runtime.objects.get(props.runtimeId)
  if (current?.generation !== generation) return
  if (element === null && current.element && current.element !== previous) return
  stopPointerBinding?.()
  stopPointerBinding = element ? bindRuntimeObjectPointer(props.runtimeId, element) : null
  runtime.objects.setElement(props.runtimeId, element)
}, { flush: 'post' })
onUnmounted(() => {
  stopPointerBinding?.()
  if (runtime.objects.get(props.runtimeId)?.generation === generation) runtime.unregisterObjectWhenIdle(props.runtimeId, generation)
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
})
</script>
