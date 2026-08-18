<template>
  <div ref="rootEl"
    class="fc-card"
    :class="{ selected, 'pre-selected': preSelected, cut, 'fc-has-thumb': hasThumb, 'no-lift': !lift, 'canvas-mode': canvasMode }"
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
  cut: { type: Boolean, default: false },
  lift: { type: Boolean, default: true },   // 悬停是否上浮 2px；Dashboard 最近文件面板不要这个位移，走 no-lift
  canvasMode: { type: Boolean, default: false },
})
</script>

<style scoped>
/* global.css 继续唯一拥有 fc-card 的结构、transition/transform 和 hover ::after 高光；
   这里唯一拥有文件卡 paint 与文件专属状态。这样不会产生 scoped/global 的 transition 竞争，
   也不会让 adoption 再用高特异性覆盖。亮色 file-card token 明确锁定 v0.20.4。 */
.fc-card {
  --fc-preselection-bg: rgba(123,127,178,.06);
  --fc-preselection-border: rgba(123,127,178,.45);
  --fc-preselection-shadow: inset 0 1px 0 rgba(255,255,255,.85), 0 0 0 1.5px rgba(123,127,178,.15);
  background: var(--file-card-bg);
  border: 1px solid var(--file-card-border);
  box-shadow: var(--file-card-shadow);
  min-height: 122px;
  color: var(--content-primary);
}
/* 画布文件引用先定义自己的玻璃基线；hover / selected 状态写在后面，因此状态始终优先于 mode 基线。 */
.fc-card.canvas-mode {
  overflow: visible;
  background: var(--surface-glass);
  border-color: var(--border-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.fc-card:hover:not(.selected):not(.pre-selected) {
  background: var(--file-card-bg-hover);
  border-color: var(--file-card-border-hover);
  box-shadow: var(--file-card-shadow-hover);
}
.fc-card.selected {
  background: var(--file-card-bg-selected);
  border-color: var(--file-card-border-selected);
  box-shadow: var(--file-card-shadow-selected);
}
/* Files/index.vue 继续拥有文件库本页的 v0.20.4 full-card preview；项目文件区过去只收到
   thumbnail preview，普通文件没有完整预框选反馈。只补 project + light；暗色由最终 theme
   adoption 做语义映射，因此同一 resolved theme 内没有两个 selector 同时抢 full-card paint。 */
:global(html[data-theme='light'][data-family] .project-modal-root) .fc-card.pre-selected:not(.selected) {
  background: var(--fc-preselection-bg);
  border-color: var(--fc-preselection-border);
  box-shadow: var(--fc-preselection-shadow);
}
/* Dashboard 最近文件面板：只要阴影变化，不要上浮位移（跟文件库/画布引用两处的默认手感
   刻意不同）；靠比 global.css `.fc-card:hover{transform:translateY(-2px)}` 更高的 scoped
   特异度覆盖回去，不需要 !important。 */
.fc-card.no-lift:hover { transform: none; }
/* 0.20.4 的选中层级：::before 覆盖整张卡（普通文件/图片标签区一致），图片缩略图区
   再叠一层更深的 ::after；两层是有意的视觉差异，不合并成同一种选中色。 */
.fc-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: var(--file-card-selection-overlay);
}
.fc-card.selected .fc-thumb-area::after,
.fc-card.pre-selected:not(.selected) .fc-thumb-area::after {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none;
}
.fc-card.selected .fc-thumb-area::after { background: var(--file-card-selection-thumb-overlay); }
.fc-card.pre-selected:not(.selected) .fc-thumb-area::after { background: var(--file-card-preselection-thumb-overlay); }
.fc-card.cut { opacity: 0.45; }

.fc-ext-badge {
  position: absolute; top: 10px; left: 10px; z-index: 2;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--fc-color, var(--color-primary));
  background: var(--file-card-badge-bg);
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
  background: var(--file-card-thumb-bg);
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
.fc-has-thumb .fc-ext-badge { background: var(--file-card-image-badge-bg); color: var(--file-card-image-badge-fg); }

.fc-label { padding: 0 13px 13px; flex: 1; min-width: 0; }
.fc-name {
  color: var(--content-primary);
  font-size: var(--font-size-sm); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { color: var(--content-secondary); font-size: 9px; line-height: 1.15; opacity: 0.55; margin-top: 2px; }
</style>
