<template>
  <article class="token-row">
    <div class="token-swatch" :style="swatchStyle" />
    <div class="token-copy"><strong>{{ token.name }}</strong><code>{{ token.variable }}</code><small>{{ token.description }}</small></div>
    <button class="copy-button" :title="`复制 ${token.variable}`" @click="$emit('copy', token)">复制</button>
    <output>{{ value }}</output>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DesignToken } from '../data/tokenCatalog'

const props = defineProps<{ token: DesignToken; value: string }>()
defineEmits<{ copy: [token: DesignToken] }>()
const swatchStyle = computed(() => props.token.type === 'color'
  ? { background: `var(${props.token.variable})` }
  : props.token.type === 'shadow' ? { boxShadow: `var(${props.token.variable})` } : {})
</script>

<style scoped>
.token-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); }
.token-swatch { width: 26px; height: 26px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); background: var(--surface-panel); }
.token-copy { min-width: 0; display: grid; gap: 2px; } .token-copy strong { font-size: var(--font-size-sm); } .token-copy code, output { color: var(--content-secondary); font-size: var(--font-size-xs); } .token-copy small { color: var(--content-muted); font-size: var(--font-size-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
output { max-width: 190px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.copy-button { border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); padding: 7px 10px; color: var(--content-secondary); background: transparent; cursor: pointer; font: inherit; font-size: var(--font-size-sm); }
.copy-button:hover { color: var(--content-primary); background: var(--surface-glass-hover); }
@media (max-width: 760px) { .token-row { grid-template-columns: 28px minmax(0, 1fr); } .token-row output, .token-row .copy-button { grid-column: 2; text-align: left; } }
</style>
