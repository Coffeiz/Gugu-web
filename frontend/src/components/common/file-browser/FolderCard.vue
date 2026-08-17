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
/* FolderCard 是文件夹卡唯一 paint owner。亮色局部 token 精确复现 v0.20.4；暗色只重映射
   token，selected / pre-selected / checkbox 的状态结构保持同一套 selector。 */
.folder-card {
  --folder-card-bg: color-mix(in srgb, var(--fd-color, #8888a0) 6%, rgba(255,255,255,.82));
  --folder-card-border: color-mix(in srgb, var(--fd-color, #8888a0) 14%, rgba(255,255,255,.92));
  --folder-card-shadow: inset 0 1px 0 rgba(255,255,255,.98), 0 1px 5px rgba(80,90,110,.06);
  --folder-card-shadow-hover: inset 0 1px 0 rgba(255,255,255,.90), 0 7px 22px rgba(80,90,110,.12);
  --folder-card-bg-selected: rgba(255,255,255,.92);
  --folder-card-border-selected: rgba(123,127,178,.55);
  --folder-card-shadow-selected: inset 0 1px 0 rgba(255,255,255,.98), 0 0 0 2px rgba(123,127,178,.28);
  --folder-card-selection-overlay: rgba(123,127,178,.14);
  --folder-card-bg-preselected: rgba(123,127,178,.05);
  --folder-card-border-preselected: rgba(123,127,178,.38);
  --folder-card-shadow-preselected: inset 0 1px 0 rgba(255,255,255,.90), 0 0 0 1.5px rgba(123,127,178,.12);
  --folder-card-checkbox-bg: rgba(255,255,255,.75);
  --folder-card-checkbox-border: rgba(123,127,178,.55);
  --folder-card-checkbox-bg-checked: var(--color-primary, #7b7fb2);
  --folder-card-checkbox-border-checked: var(--color-primary, #7b7fb2);
  --folder-card-checkbox-fg-checked: #fff;

  position: relative;
  min-height: 122px;
  border: 1px solid var(--folder-card-border);
  border-radius: 14px;
  background: var(--folder-card-bg);
  box-shadow: var(--folder-card-shadow);
  color: var(--content-primary);
}
:global(html[data-theme='dark'][data-family]) .folder-card {
  --folder-card-bg: color-mix(in srgb, var(--surface-card-solid) 94%, var(--fd-color, var(--action-primary)) 6%);
  --folder-card-border: color-mix(in srgb, var(--border-strong) 86%, var(--fd-color, var(--action-primary)) 14%);
  --folder-card-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card);
  --folder-card-shadow-hover: inset 0 1px 0 var(--highlight-soft), var(--elevation-card-hover);
  --folder-card-bg-selected: var(--surface-raised);
  --folder-card-border-selected: var(--action-outline);
  --folder-card-shadow-selected: inset 0 1px 0 var(--highlight-soft), 0 0 0 2px var(--selection-bg);
  --folder-card-selection-overlay: var(--selection-bg);
  --folder-card-bg-preselected: color-mix(in srgb, var(--action-primary) 5%, var(--surface-card-solid));
  --folder-card-border-preselected: color-mix(in srgb, var(--action-primary) 38%, transparent);
  --folder-card-shadow-preselected: inset 0 1px 0 var(--highlight-soft), 0 0 0 1.5px color-mix(in srgb, var(--action-primary) 12%, transparent);
  --folder-card-checkbox-bg: var(--surface-raised);
  --folder-card-checkbox-border: var(--action-outline);
  --folder-card-checkbox-bg-checked: var(--action-primary);
  --folder-card-checkbox-border-checked: var(--action-primary);
  --folder-card-checkbox-fg-checked: var(--content-on-accent);
}
.folder-card:hover { box-shadow: var(--folder-card-shadow-hover); }
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
.folder-card.pre-selected {
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
</style>
