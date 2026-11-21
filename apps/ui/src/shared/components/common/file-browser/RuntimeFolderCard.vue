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
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'

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
const { elementRef } = useFileRuntimeObject(() => props.runtimeId, () => ({
  type: props.runtimeType,
  surfaceId: props.runtimeSurfaceId,
  abilities: props.runtimeAbilities,
  selected: props.runtimeSelected,
  target: props.runtimeTarget,
}))

const cardRef = ref<InstanceType<typeof FolderCard> | null>(null)
watch(cardRef, card => { elementRef.value = card?.rootEl ?? null }, { immediate: true })
onUnmounted(() => {
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) {
    runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
  }
})
</script>
