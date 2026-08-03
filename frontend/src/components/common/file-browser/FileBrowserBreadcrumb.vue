<template>
  <component :is="tag" :class="className">
    <slot />
  </component>
</template>

<script setup lang="ts">
defineProps({
  className: { type: String, default: 'breadcrumb' },
  tag: { type: String, default: 'div' },
})
</script>
