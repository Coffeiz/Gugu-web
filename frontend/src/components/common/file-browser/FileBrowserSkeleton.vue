<template>
  <template v-if="variant === 'grid'">
    <div v-for="i in 8" :key="i" class="fb-sk-card">
      <div class="fb-sk-icon fb-sk-shimmer"></div>
      <div class="fb-sk-name fb-sk-shimmer"></div>
    </div>
  </template>
  <template v-else>
    <div v-for="i in 8" :key="i" class="fb-sk-row">
      <div class="fb-sk-row-icon fb-sk-shimmer"></div>
      <div class="fb-sk-row-name fb-sk-shimmer"></div>
      <div class="fb-sk-row-cell fb-sk-shimmer"></div>
      <div class="fb-sk-row-cell fb-sk-shimmer"></div>
      <div class="fb-sk-row-cell fb-sk-shimmer"></div>
    </div>
  </template>
</template>

<script setup lang="ts">
// 目录数据冷加载期间的占位骨架：与卡片/行同构的灰块，避免内容区空白后整批卡片突现。
defineProps({
  variant: { type: String as () => 'grid' | 'list', default: 'grid' },
})
</script>

<style scoped>
.fb-sk-shimmer {
  background: linear-gradient(90deg, var(--surface-soft) 25%, var(--selection-bg) 50%, var(--surface-soft) 75%);
  background-size: 200% 100%;
  animation: fb-sk-shimmer 1.4s ease-in-out infinite;
}
@keyframes fb-sk-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

.fb-sk-card {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 16px 8px;
}
.fb-sk-icon { width: 72px; height: 72px; border-radius: 16px; }
.fb-sk-name { width: 70%; height: 12px; border-radius: 6px; }

.fb-sk-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 8px;
}
.fb-sk-row-icon { width: 28px; height: 28px; border-radius: 8px; flex: none; }
.fb-sk-row-name { height: 12px; border-radius: 6px; flex: 1; }
.fb-sk-row-cell { width: 90px; height: 12px; border-radius: 6px; flex: none; }
</style>
