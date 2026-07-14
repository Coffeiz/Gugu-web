<template>
  <div ref="rootEl"
    class="fc-card"
    :class="{ selected, 'pre-selected': preSelected, dragging, cut, 'fc-has-thumb': hasThumb, 'no-lift': !lift, 'canvas-mode': canvasMode }"
    :style="{ '--fc-color': fileIconColor(ext), '--fc-area-h': `${areaHeight}px`, '--fc-icon-lift': `${iconLift}px` }"
  >
    <span class="fc-ext-badge">{{ ext }}</span>

    <div v-if="hasThumb" class="fc-thumb-area">
      <slot name="thumb"></slot>
    </div>
    <div v-else class="fc-icon-area">
      <component :is="fileListIcon(ext)" class="fc-big-icon" :size="iconSize" weight="bold" />
    </div>

    <div class="fc-label">
      <div class="fc-name" :title="displayName">
        <slot name="name">{{ displayName }}</slot>
      </div>
      <div class="fc-meta"><slot name="meta"></slot></div>
    </div>

    <slot></slot>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件卡片共用视觉（扩展名角标 + 缩略图/大图标区 + 标题/元信息），从 Files/index.vue 和
 * Dashboard/FilePanel.vue 里各自维护一份的重复 HTML 抽出来，画布引用贴纸也用同一个模块，
 * 不再各画各的近似样式。
 *
 * 缩略图和名称/元信息文案两处差异较大（懒加载指令 vs 手动 blob 缓存、size+createdAt vs
 * project+size），走具名插槽让各调用方自己决定内容；选中/预选/拖拽/剪切等状态样式是
 * Files/index.vue 专属的交互态，收成 props 由本组件统一画，不用调用方各自补一份
 * `:deep()` 才能扎进子组件根节点以外的后代（scoped CSS 对子组件模板内部的后代选择器
 * 本来就够不到，选中态叠加在缩略图上的 ::after 尤其如此）。
 */
import { ref, type PropType } from 'vue'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

const rootEl = ref<HTMLElement | null>(null)
defineExpose({ rootEl })

defineProps({
  ext: { type: String, required: true },
  displayName: { type: String, required: true },
  hasThumb: { type: Boolean, default: false },
  iconSize: { type: Number as PropType<number>, default: 86 },
  iconLift: { type: Number as PropType<number>, default: 20 },   // 大图标向下偏移量，配合渐隐蒙版做"沉底"视觉
  areaHeight: { type: Number as PropType<number>, default: 90 }, // 缩略图/大图标区高度，两处调用方尺寸不同（86/90 vs 80/80）
  selected: { type: Boolean, default: false },
  preSelected: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
  cut: { type: Boolean, default: false },
  lift: { type: Boolean, default: true },   // 悬停是否上浮 2px；Dashboard 最近文件面板不要这个位移，走 no-lift
  canvasMode: { type: Boolean, default: false },
})
</script>

<style scoped>
/* .fc-card 的 transition/悬停上浮位移(transform)/::after 高光/落地揭示后的压制态全部由
   global.css 的通用 .fc-card 规则统一提供（跟拖拽物理的 phys-just-revealed 揭示时序是配套
   的一整套，见 usePhysicsDrag.ts 的 _revealWithoutStaleHover）——这里不能再自己声明
   transition，哪怕只是想加 box-shadow/background 的过渡：CSS transition 是覆盖式属性，
   scoped 样式编译后带 data-v 属性选择器、特异度比 global.css 那份纯类选择器高，会整体
   压过它、连带把 transform 的过渡一起吃掉，悬停上浮就变成瞬间跳变、没有非线性缓动
   （踩过：FileCard.vue 抽出来时补了这句 transition，直接把文件库卡片的位移过渡吃没了）。
   这里只画本卡片专属的底色/边框/圆角/静止&悬停阴影这些「值」，动画节奏交给全局那份。 */
.fc-card {
  position: relative;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(255,255,255,0.9);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
  min-height: 122px;
  display: flex; flex-direction: column;
}
/* 画布文件引用与活动/项目引用共用系统对象的玻璃基线；文件库卡片仍保留原本更实的白底。 */
.fc-card.canvas-mode {
  overflow: visible;
  background: var(--glass-bg);
  border-color: var(--glass-border);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.fc-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 18px rgba(80,90,110,0.13);
  background: rgba(255,255,255,0.86);
}
/* Dashboard 最近文件面板：只要阴影变化，不要上浮位移（跟文件库/画布引用两处的默认手感
   刻意不同）；靠比 global.css `.fc-card:hover{transform:translateY(-2px)}` 更高的 scoped
   特异度覆盖回去，不需要 !important。 */
.fc-card.no-lift:hover { transform: none; }
.fc-card.selected {
  border-color: rgba(123,127,178,0.55);
  background: rgba(255,255,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 0 0 2px rgba(123,127,178,0.28);
}
/* 选中覆盖层：::before 覆盖整张卡（含图片卡白色标签区），::after 在缩略图上额外叠加 */
.fc-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: rgba(123,127,178,0.14);
}
.fc-card.selected .fc-thumb-area::after,
.fc-card.pre-selected .fc-thumb-area::after {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none;
}
.fc-card.selected .fc-thumb-area::after    { background: rgba(123,127,178,0.28); }
.fc-card.pre-selected .fc-thumb-area::after { background: rgba(123,127,178,0.16); }
.fc-card.dragging { opacity: 0.35; cursor: grabbing; }
.fc-card.cut { opacity: 0.45; }

.fc-ext-badge {
  position: absolute; top: 10px; left: 10px; z-index: 2;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--fc-color, var(--color-primary));
  background: rgba(0,0,0,0.04);
  border-radius: 4px; padding: 2px 5px; line-height: 1.5;
}

.fc-icon-area {
  height: var(--fc-area-h, 90px); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: visible;
}
.fc-big-icon {
  /* 实际像素尺寸交给 iconSize prop（Phosphor 组件自己的 :size，渲染成 svg width/height 属性），
     这里不再重复写死 width/height——写了 CSS 反而以更高优先级覆盖掉 prop，iconSize 就成了摆设。 */
  color: var(--fc-color, var(--color-primary));
  opacity: 0.55;
  transform: translateY(var(--fc-icon-lift, 20px));
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}

.fc-thumb-area {
  position: relative; height: var(--fc-area-h, 90px); flex-shrink: 0; overflow: hidden;
  border-radius: 14px 14px 0 0;
  background: rgba(0,0,0,0.05);
  /* 不常驻提升为 GPU 图层：画布缩放时，独立图层可能沿用抓取时的低分辨率纹理，
     直到 hover/合成器空闲才重栅格化，表现为图片卡先糊后清。拖拽时物理层会按需建层。 */
  mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
}
.fc-thumb-area :deep(img) {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: center top; display: block;
}

.fc-has-thumb .fc-label { position: relative; z-index: 1; }
.fc-has-thumb .fc-ext-badge { background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.92); }

.fc-label { padding: 0 13px 13px; flex: 1; min-width: 0; }
.fc-name {
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { font-size: 9px; line-height: 1.15; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }
</style>
