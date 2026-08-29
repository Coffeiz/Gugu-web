<template>
  <div class="mind-page">
    <!-- 顶部条：胶囊（椭圆）水平居中，筛选靠右（grid 三列保证真居中，不被右侧内容挤偏）。
         topbar 在本页被隐藏，全局搜索由筛选框补位——在思维面板里想找的是自己的便签。 -->
    <div class="mind-bar">
      <div class="mind-bar-side"></div>
      <SegmentedControl class="mind-tabs" :active-index="isCanvas ? 1 : 0" style="--pill-radius: 999px">
        <RouterLink to="/mind/notes" class="mind-tab" :class="{ on: isNotes }">
          <PhNotePencil :size="16" weight="bold" />
          笔记
        </RouterLink>
        <RouterLink to="/mind/canvases" class="mind-tab" :class="{ on: isCanvas }">
          <PhGraph :size="16" weight="bold" />
          画布
        </RouterLink>
      </SegmentedControl>
      <div class="mind-bar-side right">
        <template v-if="isNotes">
          <DatePicker
            v-model="store.jumpTarget"
            class="mind-cal-picker"
            popup-class="mind-cal-popup"
            :max="todayIso"
            :allowed-dates="store.timeline.map(g => g.date)"
            :show-clear="false"
            title="选择日期跳转"
          />
          <div class="mind-filter">
            <PhMagnifyingGlass :size="13" weight="bold" class="mf-icon" />
            <input v-model="store.filterQ" type="text" placeholder="筛选笔记…" />
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
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { PhGraph, PhMagnifyingGlass, PhNotePencil, PhX } from '@phosphor-icons/vue'
import { useMindStore } from '@/stores/mind'
import { localDayKey } from '@/utils/dateAttribution'
import DatePicker from '@/components/common/DatePicker.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'

const route = useRoute()
const store = useMindStore()
const isNotes = computed(() => route.path.startsWith('/mind/notes'))
const isCanvas = computed(() => route.path.startsWith('/mind/canvases'))
const todayIso = computed(() => localDayKey(new Date()))   // 本地今天（不是 UTC）

// /mind 是侧栏唯一入口；把当前子视图记下来，下一次从侧栏回来时由路由重定向恢复它。
watch(() => route.path, (path) => {
  if (path.startsWith('/mind/notes')) localStorage.setItem('mind-last-mode', 'notes')
  else if (path.startsWith('/mind/canvases')) localStorage.setItem('mind-last-mode', 'canvas')
}, { immediate: true })
</script>

<style scoped>
.mind-page { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }

/* pointer-events:none 是关键：grid 的 1fr 1fr 两侧列即便没有任何可见内容（画布页整段
   right 列都是空的，left 列本来就一直是空的），作为真实的 <div> 默认仍然会吃掉点击——
   这层容器横跨了几乎整个页面宽度、z-index 又比画布自己浮层面板（CanvasSidebar/
   CanvasToolbar，见 CanvasSidebar.vue / CanvasToolbar.vue，都是 UI 层 z-index:40）更高，实际盖住了画布左上角面板按钮
   的下半部分（用户反馈"只有按钮顶部能点，中间点不了"）——画布的 .canvas-page 是
   position:fixed;inset:0，跟这条 bar 同属 .mind-page 的兄弟节点，画布浮层再怎么调自己
   内部的 z-index 也逃不出 .mind-bar 这个外层容器的手掌心。跟 RelationLayer.vue 的
   .relation-layer 同一个套路：容器本身不吃点击，只在真正有交互内容的子元素上单独开
   pointer-events:auto（.mind-tabs 胶囊、右侧筛选/日期选择器），可见即可点，空白区域
   点击穿透到下层。 */
.mind-bar {
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 12px;
  position: relative; z-index: 40; pointer-events: none;
  flex-shrink: 0; margin: 28px 24px 0;
}
.mind-body { position: relative; z-index: 1; flex: 1; min-height: 0; }
.mind-bar-side { display: flex; align-items: center; }
.mind-bar-side.right { justify-content: flex-end; gap: 10px; pointer-events: auto; }

/* DatePicker 自己负责主题 paint；思维页只保留圆形触发器的几何。之前这里用
   !important 强制半透明白背景/白边框，直接压掉了暗色 token。 */
:deep(.mind-cal-picker) { width: auto !important; }
:deep(.mind-cal-picker .dp-input) {
  width: 40px; height: 40px; padding: 0; box-sizing: border-box; justify-content: center;
  border-radius: 999px;
}
:deep(.mind-cal-picker .dp-input span) { display: none; }

/* 椭圆胶囊：尺寸对齐日历页的月/周切换（.view-toggle），只把圆角换成全圆；基础视觉
   保留原方案，Mono/Mono 的浮动 chrome 材质由 adoption/mind.css 统一重映射。 */
.mind-tabs {
  gap: 2px; padding: 2px;
  border-radius: 999px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  pointer-events: auto;
}
.mind-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 36px; box-sizing: border-box; padding: 0 17px; border-radius: 999px;
  font-size: 13.5px; font-weight: 600; color: var(--text-secondary);
  text-decoration: none; cursor: pointer;
  transition: color 0.15s;
}
.mind-tab:hover { color: var(--color-primary); }

/* Theme-sensitive filter paint lives in adoption/mind.css; this component owns geometry only. */
.mind-filter {
  display: flex; align-items: center; gap: 6px;
  width: 200px; height: 40px; box-sizing: border-box;
  margin-right: 14px; padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 999px;
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
</style>
