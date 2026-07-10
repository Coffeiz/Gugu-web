<template>
  <div class="mind-page">
    <!-- 页面壳：记录 / 画布切换。画布是 P2，先占位并禁用。 -->
    <div class="mind-tabs">
      <RouterLink to="/mind/records" class="mind-tab" :class="{ on: isRecords }">
        <PhNotePencil :size="14" weight="bold" />
        记录
      </RouterLink>
      <div class="mind-tab disabled" title="画布还在做（P2）">
        <PhGraph :size="14" weight="bold" />
        画布
        <span class="soon">咕了</span>
      </div>
    </div>

    <div class="mind-body">
      <RouterView />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { PhGraph, PhNotePencil } from '@phosphor-icons/vue'

const route = useRoute()
const isRecords = computed(() => route.path.startsWith('/mind/records'))
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }

.mind-tabs {
  display: inline-flex; gap: 2px; padding: 3px; align-self: flex-start;
  border-radius: 10px; background: rgba(123,127,178,0.1);
}
.mind-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 14px; border-radius: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--text-secondary);
  text-decoration: none; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.mind-tab:hover:not(.disabled) { color: var(--color-primary); }
.mind-tab.on { background: #fff; color: #5a5e86; box-shadow: 0 1px 4px rgba(60,70,100,0.12); }
.mind-tab.disabled { opacity: 0.5; cursor: not-allowed; }
.soon {
  font-size: 9px; font-weight: 700; line-height: 14px;
  padding: 0 4px; border-radius: 4px;
  background: rgba(123,127,178,0.18); color: var(--color-primary);
}

.mind-body { flex: 1; min-height: 0; }
</style>
