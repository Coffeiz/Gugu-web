<template>
  <div class="dev-home">
    <h2>Dev 工具</h2>
    <p class="hint">仅本地开发环境可见，生产构建不包含这个页面和它链接的所有工具。</p>
    <ul class="tool-list">
      <li v-for="tool in devToolRegistry" :key="tool.path">
        <router-link :to="tool.path">{{ tool.label }}</router-link>
        <p class="desc">{{ tool.description }}</p>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { devToolRegistry } from './devRegistry'
</script>

<style scoped>
.dev-home { max-width: 640px; margin: 0 auto; padding: 28px 24px; color: var(--text-primary, #2a2a3a); }
.hint { color: var(--text-secondary, #6b6b7a); font-size: 13px; margin-bottom: 20px; }
.tool-list { list-style: none; padding: 0; margin: 0; }
.tool-list li { padding: 14px 0; border-bottom: 1px solid #ececf2; }
.tool-list a { font-size: 15px; font-weight: 600; text-decoration: none; color: var(--accent, #4a6cf7); }
.tool-list a:hover { text-decoration: underline; }
.desc { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary, #6b6b7a); }
</style>
