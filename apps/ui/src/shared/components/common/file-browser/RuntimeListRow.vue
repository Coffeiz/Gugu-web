<template>
  <div ref="elementRef" v-bind="$attrs"><slot /></div>
</template>

<script setup lang="ts">
import { onUnmounted, type PropType } from 'vue'
import { runtime, type TargetItem } from '@/interaction/runtime'
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'

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
const { elementRef } = useFileRuntimeObject(() => props.runtimeId, () => ({
  type: props.runtimeType,
  surfaceId: props.runtimeSurfaceId,
  abilities: props.runtimeAbilities,
  selected: props.runtimeSelected,
  target: props.runtimeTarget,
}))

onUnmounted(() => {
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
})
</script>
