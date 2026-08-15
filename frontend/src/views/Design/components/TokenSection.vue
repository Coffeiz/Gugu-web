<template>
  <section class="token-section">
    <div class="section-heading"><h2>{{ title }}</h2><span>{{ tokens.length }} tokens</span></div>
    <div class="token-grid"><TokenRow v-for="token in tokens" :key="token.variable" :token="token" :value="valueOf(token)" @copy="$emit('copy', $event)" /></div>
  </section>
</template>

<script setup lang="ts">
import TokenRow from './TokenRow.vue'
import type { DesignToken } from '../data/tokenCatalog'

defineProps<{ title: string; tokens: DesignToken[]; valueOf: (token: DesignToken) => string }>()
defineEmits<{ copy: [token: DesignToken] }>()
</script>

<style scoped>
.token-section { max-width: 1180px; margin: 0 auto 28px; } .section-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; } .section-heading h2 { font-size: var(--font-size-lg); } .section-heading span { color: var(--content-muted); font-size: var(--font-size-xs); }
.token-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
@media (max-width: 760px) { .token-grid { grid-template-columns: 1fr; } }
</style>
