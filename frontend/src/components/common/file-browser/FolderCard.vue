<template>
  <div
    ref="rootEl"
    v-bind="$attrs"
    class="folder-card"
    :class="{ selected, 'pre-selected': preSelected }"
    :style="{ '--fd-color': accentColor }"
  >
    <div class="fd-icon-area">
      <slot name="icon" />
    </div>

    <div class="fd-label">
      <div class="fd-name" :title="displayName">
        <slot name="name">{{ displayName }}</slot>
      </div>
      <div class="fd-count"><slot name="count">{{ countLabel }}</slot></div>
    </div>

    <Transition name="sel-cb">
      <div v-if="selectionMode" class="sel-checkbox" :class="{ checked: selected }">
        <svg v-if="selected" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 6l3 3 5-5" />
        </svg>
      </div>
    </Transition>

    <div v-if="!selectionMode" class="fd-hover-actions">
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
  selectionMode: { type: Boolean, default: false },
})
</script>

<style scoped>
/* FolderCard 只拥有实体结构与状态 selector；Aero/Mono × light/dark 的基线 paint 值全部来自
   tokens/components/surfaces.css。最终 surface/edge 在卡片本地混入 --fd-color，因为文件夹
   accent 是逐卡动态值，不能提前在 :root 上求值。 */
.folder-card {
  --folder-card-bg: color-mix(in srgb,var(--fd-color,#8888a0) 6%,var(--folder-card-bg-base));
  --folder-card-border: color-mix(in srgb,var(--fd-color,#8888a0) 14%,var(--folder-card-border-base));
  --folder-card-bg-hover: color-mix(in srgb,var(--fd-color,#8888a0) 8%,var(--folder-card-bg-base));
  --folder-card-border-hover: color-mix(in srgb,var(--fd-color,#8888a0) 18%,var(--folder-card-border-base));

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
  background: var(--folder-card-bg-selected);
  box-shadow: var(--folder-card-shadow-selected);
}
.folder-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: var(--folder-card-selection-overlay);
}
.folder-card.pre-selected:not(.selected) {
  border-color: var(--folder-card-border-preselected);
  background: var(--folder-card-bg-preselected);
  box-shadow: var(--folder-card-shadow-preselected);
}
.fd-icon-area {
  height: 90px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; overflow: visible;
}
.fd-icon-area :deep(.fd-big-icon) {
  width: 92px; height: 92px; flex-shrink: 0;
  color: var(--fd-color, var(--color-primary)); opacity: 0.58;
  transform: translateY(20px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
}
.fd-label { padding: 0 13px 13px; }
.fd-name {
  font-size: 11.5px; font-weight: 600; color: var(--content-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
/* 展示态继续截断长文件夹名；重命名时放开裁切，让共享 input focus glow 不被名称行吃掉。 */
.fd-name:has(.rename-sizer) { overflow: visible; text-overflow: clip; }
.fd-count { font-size: 9px; line-height: 1.15; color: var(--content-secondary); opacity: 0.55; margin-top: 2px; }
.fd-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.folder-card:hover .fd-hover-actions { opacity: 1; }
.sel-checkbox {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid var(--folder-card-checkbox-border);
  background: var(--folder-card-checkbox-bg);
  box-shadow: none;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.sel-checkbox.checked {
  color: var(--folder-card-checkbox-fg-checked);
  background: var(--folder-card-checkbox-bg-checked);
  border-color: var(--folder-card-checkbox-border-checked);
}
.sel-cb-enter-from, .sel-cb-leave-to { opacity: 0; }
/* leave 只走 opacity（同 FileCard.vue 的注释）：离场冻结 paint，避免选中填充
   先变色再淡完导致结尾闪烁。 */
.folder-card .sel-cb-leave-active { transition: opacity 0.15s ease; }
</style>
