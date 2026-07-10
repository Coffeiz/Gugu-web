<template>
  <div class="mind-page">
    <!-- 顶部条：胶囊（椭圆）水平居中，筛选靠右（grid 三列保证真居中，不被右侧内容挤偏）。
         topbar 在本页被隐藏，全局搜索由筛选框补位——在思维面板里想找的是自己的便签。 -->
    <div class="mind-bar">
      <div class="mind-bar-side"></div>
      <div class="mind-tabs">
        <RouterLink to="/mind/records" class="mind-tab" :class="{ on: isRecords }">
          <PhNotePencil :size="16" weight="bold" />
          记录
        </RouterLink>
        <div class="mind-tab disabled" title="画布还在做（P2）">
          <PhGraph :size="16" weight="bold" />
          画布
          <span class="soon">咕了</span>
        </div>
      </div>
      <div class="mind-bar-side right">
        <template v-if="isRecords">
          <DatePicker
            v-model="store.jumpTarget"
            class="mind-cal-picker"
            popup-class="mind-cal-popup"
            :max="todayIso"
            :allowed-dates="store.timeline.map(g => g.date)"
            title="选择日期跳转"
          />
          <div class="mind-filter">
            <PhMagnifyingGlass :size="13" weight="bold" class="mf-icon" />
            <input v-model="store.filterQ" type="text" placeholder="筛选便签…" />
            <button v-if="store.filterQ" class="mf-clear" title="清除" @click="store.filterQ = ''">
              <PhX :size="11" weight="bold" />
            </button>
          </div>
        </template>
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
import DatePicker from '@/components/common/DatePicker.vue'

const route = useRoute()
const store = useMindStore()
const isRecords = computed(() => route.path.startsWith('/mind/records'))
const todayIso = computed(() => new Date().toISOString().slice(0, 10))
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }

.mind-bar {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 12px;
  position: relative; z-index: 12;
  flex-shrink: 0; padding: 0 2px;
}
.mind-body { position: relative; z-index: 1; }
.mind-bar-side { display: flex; align-items: center; }
.mind-bar-side.right { justify-content: flex-end; gap: 10px; }

:deep(.mind-cal-picker) { width: auto !important; }
:deep(.mind-cal-picker .dp-input) {
  width: 40px; height: 40px; padding: 0; box-sizing: border-box; justify-content: center;
  border-radius: 999px; border: 1px solid rgba(255,255,255,0.75);
  background: rgba(255,255,255,0.52); box-shadow: none;
}
:deep(.mind-cal-picker .dp-input:hover),
:deep(.mind-cal-picker .dp-input.open) { background: rgba(255,255,255,0.75); box-shadow: none; }
:deep(.mind-cal-picker .dp-input span) { display: none; }
:deep(.mind-cal-picker .dp-icon) { color: var(--color-primary); }

/* 排查中：弹层 Teleport 到 body 后不再是本组件后代，:deep 够不到，用 popup-class + :global
   单独测试去掉这个弹层自己的 backdrop-filter 是否是记录页玻璃卡冒白块的元凶（怀疑跟另一层
   backdrop-filter 玻璃卡叠在一起时，弹层内部重绘要求重新采样背后内容，撞出白块）。
   背景提高不透明度补偿视觉上失去的模糊感。 */
:global(.mind-cal-popup) {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  background: rgba(238,240,246,0.98) !important;
}

/* 椭圆胶囊：颜色/透明度/尺寸对齐日历页的月/周切换（.view-toggle），只把圆角换成全圆 */
.mind-tabs {
  display: inline-flex; gap: 2px; padding: 2px;
  border-radius: 999px; background: rgba(123,127,178,0.1);
}
.mind-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 36px; box-sizing: border-box; padding: 0 17px; border-radius: 999px;
  font-size: 13.5px; font-weight: 600; color: var(--text-secondary);
  text-decoration: none; cursor: pointer;
  transition: all 0.15s;
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
  width: 200px; height: 40px; box-sizing: border-box;
  margin-right: 14px; padding: 0 12px;
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
