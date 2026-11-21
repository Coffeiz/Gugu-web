<template>
  <ContextMenu :show="show" :x="x" :y="y" @close="$emit('close')">
    <slot />
  </ContextMenu>
</template>

<script setup lang="ts">
import ContextMenu from '@/components/common/overlays/ContextMenu.vue'

defineProps({
  show: Boolean,
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
})

defineEmits(['close'])
</script>
