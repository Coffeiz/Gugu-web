<template>
  <div
    ref="rootEl"
    v-bind="$attrs"
    class="folder-card"
    :title="displayName"
    :class="{ selected, 'pre-selected': preSelected, cut }"
    :style="{ '--fd-color': accentColor }"
  >
    <div class="fd-icon-area">
      <slot name="icon" />
    </div>

    <div class="fd-label">
      <div class="fd-name" :title="displayName">
        <slot name="name">{{ displayName }}</slot>
      </div>
      <div class="fd-count" :title="countLabel"><slot name="count">{{ countLabel }}</slot></div>
    </div>

    <Transition name="sel-cb">
      <div v-if="selectionMode" class="sel-checkbox" :class="{ checked: selected }">
        <svg v-if="selected" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 6l3 3 5-5" />
        </svg>
      </div>
    </Transition>

    <div v-if="!selectionMode" class="file-card-hover-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件夹网格卡片的共享展示壳。
 * 文件库和项目文件区保留各自的点击、拖拽、重命名和操作按钮，通过根节点事件透传与插槽接入。
 */
import { ref } from 'vue'

defineOptions({ inheritAttrs: false })

const rootEl = ref<HTMLElement | null>(null)
defineExpose({ rootEl })

defineProps({
  displayName: { type: String, required: true },
  countLabel: { type: String, default: '—' },
  accentColor: { type: String, default: '#8888a0' },
  selected: { type: Boolean, default: false },
  preSelected: { type: Boolean, default: false },
  cut: { type: Boolean, default: false },
  selectionMode: { type: Boolean, default: false },
})
</script>

<style scoped>
/* 底色与文件卡共享；逐卡的文件夹强调色用于图标和描边。 */
.folder-card {
  --folder-card-bg: var(--file-card-bg);
  --folder-card-border: color-mix(in srgb,var(--fd-color,#8888a0) var(--folder-card-border-accent,14%),var(--folder-card-border-base));
  --folder-card-bg-hover: var(--file-card-bg-hover);
  --folder-card-border-hover: var(--file-card-border-hover);
  --folder-card-shadow-hover: var(--file-card-shadow-hover);

  position: relative;
  min-height: 122px;
  border: 1px solid var(--folder-card-border);
  border-radius: 14px;
  background: var(--folder-card-bg);
  box-shadow: var(--folder-card-shadow);
  color: var(--content-primary);
}
.folder-card:hover:not(.selected):not(.pre-selected) {
  background: var(--folder-card-bg-hover);
  border-color: var(--folder-card-border-hover);
  box-shadow: var(--folder-card-shadow-hover);
}
.folder-card.selected {
  border-color: var(--folder-card-border-selected);
}
/* 选择态只叠主题色遮罩；常驻伪元素确保移除 selected 后仍可淡出。 */
.folder-card::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: var(--folder-card-selection-overlay);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.folder-card.selected::before { opacity: 1; }
.folder-card.pre-selected:not(.selected) {
  border-color: var(--folder-card-border-preselected);
  background: var(--folder-card-bg-preselected);
}
.fd-icon-area {
  height: 90px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; overflow: visible;
}
.fd-icon-area :deep(.fd-big-icon) {
  width: 92px; height: 92px; flex-shrink: 0;
  color: var(--fd-color, var(--color-primary)); opacity: 0.58;
  transform: translateY(20px);
  mask-image: var(--file-card-media-mask);
  -webkit-mask-image: var(--file-card-media-mask);
}
.fd-label { padding: 0 var(--space-md) var(--space-md); min-width: 0; }
.fd-name {
  font-size: 11.5px; font-weight: 600; color: var(--content-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: var(--space-xs); margin-bottom: calc(-1 * var(--space-xs));
}
/* 输入框宽度限制在名称栏内，卡片根节点负责最终裁切。 */
.fd-name:has(.rename-sizer) { overflow: visible; text-overflow: clip; }
.fd-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; line-height: 1.15; color: var(--content-secondary); opacity: 0.55; margin-top: var(--space-xs); }
.sel-cb-enter-from, .sel-cb-leave-to { opacity: 0; }
/* leave 只走 opacity（同 FileCard.vue 的注释）：离场冻结 paint，避免选中填充
   先变色再淡完导致结尾闪烁。 */
.folder-card .sel-cb-leave-active { transition: opacity 0.15s ease; }
</style>
