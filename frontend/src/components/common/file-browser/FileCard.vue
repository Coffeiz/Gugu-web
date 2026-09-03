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
      <component :is="fileListIcon(ext)" class="fc-big-icon" :size="iconSize" />
    </div>

    <div class="fc-label">
      <div class="fc-name" :title="displayName">
        <slot name="name">{{ displayName }}</slot>
      </div>
      <div class="fc-meta"><slot name="meta"></slot></div>
    </div>

    <Transition name="sel-cb">
      <div v-if="selectionMode" class="sel-checkbox" :class="{ checked: selected }">
        <svg v-if="selected" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 6l3 3 5-5" />
        </svg>
      </div>
    </Transition>

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
 * project+size），走具名插槽让各调用方自己决定内容；选中/预选/拖拽/剪切等状态样式收成
 * props 由本组件统一画，不用调用方再用跨组件 scoped selector 接管内部 paint。
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
  iconLift: { type: Number as PropType<number>, default: 20 },
  areaHeight: { type: Number as PropType<number>, default: 90 },
  selected: { type: Boolean, default: false },
  preSelected: { type: Boolean, default: false },
  cut: { type: Boolean, default: false },
  lift: { type: Boolean, default: true },
  canvasMode: { type: Boolean, default: false },
  selectionMode: { type: Boolean, default: false },
})
</script>

<style scoped>
/* global.css 继续唯一拥有 fc-card 的结构、transition/transform 和 hover ::after 高光；
   这里唯一拥有文件卡 paint 与文件专属状态。亮色 file-card token 明确锁定 v0.20.4。 */
.fc-card {
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
/* Full-card 预框选属于 FileCard 自己；不同主题只通过专用 token 调整强度。 */
.fc-card.pre-selected:not(.selected) {
  background: var(--file-card-preselection-bg);
  border-color: var(--file-card-preselection-border);
  box-shadow: var(--file-card-preselection-shadow);
}
/* Dashboard 最近文件面板：只要阴影变化，不要上浮位移。 */
.fc-card.no-lift:hover { transform: none; }
/* 0.20.4 的选中层级：::before 覆盖整张卡，图片缩略图区再叠一层更深的 ::after。 */
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
  mask-image: linear-gradient(to bottom, black 72%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 72%, transparent 100%);
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
/* 展示态继续截断长文件名；只有进入重命名时临时放开裁切，让 input focus glow 完整溢出。 */
.fc-name:has(.rename-sizer) { overflow: visible; text-overflow: clip; }
.fc-meta { color: var(--content-secondary); font-size: 9px; line-height: 1.15; opacity: 0.55; margin-top: 2px; }

/* 多选 checkbox：与 FolderCard 保持一致的位置和样式 */
.fc-card .sel-checkbox {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid var(--file-card-checkbox-border, rgba(123,127,178,0.55));
  background: var(--file-card-checkbox-bg, rgba(255,255,255,0.75));
  box-shadow: none;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.fc-card .sel-checkbox.checked {
  color: var(--file-card-checkbox-fg-checked, var(--color-primary,#7b7fb2));
  background: var(--file-card-checkbox-bg-checked, var(--color-primary,#7b7fb2));
  border-color: var(--file-card-checkbox-border-checked, var(--color-primary,#7b7fb2));
}
.sel-cb-enter-from, .sel-cb-leave-to { opacity: 0; }
/* leave 只走 opacity（同 filesListRows.css 的注释）：退出多选时 clearSelection 同帧移除
   .checked，若背景/边框也过渡，选中填充会先变色再淡完，暗色下结尾明显闪一下。 */
.fc-card .sel-cb-leave-active { transition: opacity 0.15s ease; }
</style>
