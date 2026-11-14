<template>
  <div class="mcp-route-page">
    <section class="mcp-panel glass-card">
      <McpServersView />
    </section>
  </div>
</template>

<script setup lang="ts">
import McpServersView from '@/views/Skills/McpServersView.vue'
</script>

<style scoped>
.mcp-route-page { height:100%; font-family:var(--font-sans); }
.mcp-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:0 24px; }
</style>
