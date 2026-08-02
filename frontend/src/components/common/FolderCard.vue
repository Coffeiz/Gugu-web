<template>
  <div
    v-bind="$attrs"
    class="folder-card"
    :class="{ selected, 'pre-selected': preSelected, 'drag-over': dragOver }"
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
        <svg v-if="selected" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
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
defineOptions({ inheritAttrs: false })

defineProps({
  displayName: { type: String, required: true },
  countLabel: { type: String, default: '—' },
  accentColor: { type: String, default: '#8888a0' },
  selected: { type: Boolean, default: false },
  preSelected: { type: Boolean, default: false },
  dragOver: { type: Boolean, default: false },
  selectionMode: { type: Boolean, default: false },
})
</script>

<style scoped>
.folder-card {
  position: relative;
  min-height: 122px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--fd-color, #8888a0) 6%, rgba(255,255,255,0.82));
  border: 1px solid color-mix(in srgb, var(--fd-color, #8888a0) 14%, rgba(255,255,255,0.92));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
}
.folder-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 7px 22px rgba(80,90,110,0.12);
}
.folder-card.selected {
  border-color: rgba(123,127,178,0.55);
  background: rgba(255,255,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 0 0 2px rgba(123,127,178,0.28);
}
.folder-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: rgba(123,127,178,0.14);
}
.folder-card.pre-selected {
  border-color: rgba(123,127,178,0.38);
  background: rgba(123,127,178,0.05);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 1.5px rgba(123,127,178,0.12);
}
.folder-card.drag-over {
  background: color-mix(in srgb, var(--fd-color, var(--color-primary)) 12%, rgba(255,255,255,0.9));
  border-color: color-mix(in srgb, var(--fd-color, var(--color-primary)) 55%, rgba(255,255,255,0.6));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 2px color-mix(in srgb, var(--fd-color, var(--color-primary)) 30%, transparent);
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
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fd-count { font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }
.fd-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.folder-card:hover .fd-hover-actions { opacity: 1; }
.sel-checkbox {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid rgba(123, 127, 178, 0.55);
  background: rgba(255,255,255,0.75);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
.sel-cb-enter-from, .sel-cb-leave-to { opacity: 0; }
</style>
