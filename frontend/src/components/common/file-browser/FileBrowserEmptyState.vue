<template>
  <div :class="variant === 'list' ? 'list-empty' : 'grid-empty'">
    <svg v-if="variant === 'trash'" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
      <path d="M5 8h22M10 8V6h12monoM13 13v7M19 13v7M6 8l1.5 15a2 2 0 002 1.8h13a2 2 0 002-1.8L26 8"/>
    </svg>
    <svg v-else-if="variant === 'grid'" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
      <path d="M4 9a2 2 0 012-2h5l2 2h10a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/>
    </svg>
    <svg v-else width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.3">
      <path d="M4 8a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>
    </svg>
    {{ text }}
  </div>
</template>

<script setup lang="ts">
defineProps({
  variant: { type: String as () => 'grid' | 'list' | 'trash', default: 'grid' },
  text: { type: String, default: '暂无文件' },
})
</script>

<style scoped>
.list-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 8px; padding: 56px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.5;
}
.grid-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 72px 0;
  font-size: 12px; color: var(--text-secondary); opacity: 0.5;
}
</style>
