<template>
  <div class="file-browser-grid" :class="className" @contextmenu.prevent.self="emit('empty-context', $event)">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps({ className: { type: String, default: 'file-grid' } })
const emit = defineEmits<{ 'empty-context': [event: MouseEvent] }>()
</script>
