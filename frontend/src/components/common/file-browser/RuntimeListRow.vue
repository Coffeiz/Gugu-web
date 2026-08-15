<template>
  <div ref="elementRef" v-bind="$attrs"><slot /></div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { useObject, useSurface, type ObjectTargetOptions } from '@/interaction/runtime/vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, required: true },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] },
  runtimeSelected: { type: Boolean, default: false },
  runtimeTarget: { type: Object as PropType<ObjectTargetOptions | undefined>, default: undefined },
})

const targetSurfaceId = props.runtimeTarget?.surfaceId ?? `${props.runtimeId}:surface`
useSurface({ id: targetSurfaceId, type: 'file-folder', layout: 'grid', accepts: ['file-item', 'folder-item'] })
const { elementRef } = useObject({
  id: props.runtimeId,
  type: () => props.runtimeType,
  surface: () => props.runtimeSurfaceId,
  abilities: () => props.runtimeAbilities,
  selected: () => props.runtimeSelected,
  target: () => props.runtimeTarget,
})
</script>
