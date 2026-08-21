<template>
  <FolderCard ref="cardRef" v-bind="forwardedAttrs"
    :display-name="String(cardProps.displayName ?? '')">
    <template #icon><slot name="icon" /></template>
    <template #name><slot name="name" /></template>
    <template #count><slot name="count" /></template>
    <template #actions><slot name="actions" /></template>
  </FolderCard>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useAttrs, watch, type PropType } from 'vue'
import FolderCard from './FolderCard.vue'
import { runtime, type TargetItem } from '@/interaction/runtime'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  cardProps: { type: Object as PropType<Record<string, unknown>>, required: true },
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, default: 'folder-item' },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] },
  runtimeSelected: { type: Boolean, default: false },
  runtimeTarget: { type: Object as PropType<Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined>, default: undefined },
})
const attrs = useAttrs()
const forwardedAttrs = computed(() => ({ ...attrs, ...props.cardProps }))
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
  stopPointerBinding = element ? runtime.bindObjectPointer(props.runtimeId, element) : null
  runtime.objects.setElement(props.runtimeId, element)
}, { flush: 'post' })

const cardRef = ref<InstanceType<typeof FolderCard> | null>(null)
watch(cardRef, card => { elementRef.value = card?.rootEl ?? null }, { immediate: true })
onUnmounted(() => {
  stopPointerBinding?.()
  if (runtime.objects.get(props.runtimeId)?.generation === generation) {
    runtime.unregisterObjectWhenIdle(props.runtimeId, generation)
  }
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) {
    runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
  }
})
</script>
