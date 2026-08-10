<template>
  <button ref="elementRef" v-bind="$attrs"><slot /></button>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { useTarget } from '@/interaction/runtime/vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  targetId: { type: String, required: true },
  surfaceId: { type: String, required: true },
  accepts: { type: Array as PropType<readonly string[]>, default: () => ['file-item', 'folder-item'] },
  priority: { type: Number, default: 1 },
})

const { elementRef } = useTarget({
  id: props.targetId,
  surfaceId: () => props.surfaceId,
  accepts: () => props.accepts,
  priority: () => props.priority,
})
</script>
