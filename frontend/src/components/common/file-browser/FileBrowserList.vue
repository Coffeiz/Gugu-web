<template>
  <div class="file-browser-list" :class="className" @contextmenu.prevent.self="emit('empty-context', $event)">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps({ className: { type: String, default: 'file-list' } })
const emit = defineEmits<{ 'empty-context': [event: MouseEvent] }>()
</script>
