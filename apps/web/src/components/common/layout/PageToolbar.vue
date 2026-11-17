<template>
  <div class="page-toolbar glass-card">
    <GlassBg />
    <slot />
  </div>
</template>

<script setup lang="ts">
import GlassBg from './GlassBg.vue'
</script>

<style>
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  flex-shrink: 0;
  position: relative;
  isolation: isolate;
  background: transparent;
  overflow: hidden;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
</style>
