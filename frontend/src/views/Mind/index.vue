<template>
  <div class="mind-page">
    <!-- 顶部条：胶囊（椭圆）水平居中，筛选靠右（grid 三列保证真居中，不被右侧内容挤偏）。
         topbar 在本页被隐藏，全局搜索由筛选框补位——在思维面板里想找的是自己的便签。 -->
    <div class="mind-bar">
      <div class="mind-bar-side"></div>
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
      <div class="mind-bar-side right">
        <div class="mind-filter" v-if="isRecords">
          <PhMagnifyingGlass :size="13" weight="bold" class="mf-icon" />
          <input v-model="store.filterQ" type="text" placeholder="筛选便签…" />
          <button v-if="store.filterQ" class="mf-clear" title="清除" @click="store.filterQ = ''">
            <PhX :size="11" weight="bold" />
          </button>
        </div>
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
import { PhGraph, PhMagnifyingGlass, PhNotePencil, PhX } from '@phosphor-icons/vue'
import { useMindStore } from '@/stores/mind'

const route = useRoute()
const store = useMindStore()
const isRecords = computed(() => route.path.startsWith('/mind/records'))
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; }

.mind-bar {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 12px;
  flex-shrink: 0; padding: 0 2px;
}
.mind-bar-side { display: flex; }
.mind-bar-side.right { justify-content: flex-end; }

/* 椭圆胶囊：整体与选中态都走全圆角 */
.mind-tabs {
  display: inline-flex; gap: 2px; padding: 3px;
  border-radius: 999px; background: rgba(123,127,178,0.1);
}
.mind-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 16px; border-radius: 999px;
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

.mind-filter {
  display: flex; align-items: center; gap: 6px;
  width: 200px; padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255,255,255,0.52);
  border: 1px solid rgba(255,255,255,0.75);
}
.mf-icon { flex-shrink: 0; color: var(--text-secondary); opacity: 0.7; }
.mind-filter input {
  flex: 1; min-width: 0; border: none; outline: none; background: none;
  font-size: 12.5px; color: var(--text-primary); font-family: var(--font-sans);
}
.mind-filter input::placeholder { color: var(--text-secondary); opacity: 0.6; }
.mf-clear {
  flex-shrink: 0; display: inline-flex; padding: 2px;
  border: none; border-radius: 4px; background: none;
  color: var(--text-secondary); cursor: pointer;
}
.mf-clear:hover { background: rgba(0,0,0,0.06); }

.mind-body { flex: 1; min-height: 0; }
</style>
