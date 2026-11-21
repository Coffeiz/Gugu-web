<script setup lang="ts">
import { useDelayedSkeleton } from '@/composables/core/useDelayedSkeleton'

// preserve-shell 供自身包含玻璃面板的骨架使用，面板可在占位内容之前挂载。
const props = defineProps({ preserveShell: Boolean })
const visible = useDelayedSkeleton(() => true)
</script>

<template>
  <slot v-if="visible || props.preserveShell" :visible="visible" />
</template>
