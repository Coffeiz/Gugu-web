<template>
  <div
    v-if="mode === 'grid'"
    class="fc-ghost"
    :class="{ error, 'fc-ghost-folder': isFolder }"
    :style="{ '--fc-color': color }"
  >
    <div class="fc-ghost-fill" :style="{ width: `${progress}%` }" />
    <span v-if="!isFolder" class="fc-ext-badge">{{ ext || '—' }}</span>
    <div class="fc-icon-area">
      <Icon name="file.folder" v-if="isFolder" class="fc-big-icon" :size="86" />
      <component v-else :is="fileListIcon(ext)" class="fc-big-icon" :size="86" />
    </div>
    <div class="fc-label">
      <div class="fc-name" :title="name">{{ name }}</div>
      <div class="fc-meta fc-ghost-meta">{{ statusText }}</div>
    </div>
  </div>

  <div v-else class="list-row fc-ghost-row" :class="[`fc-ghost-row-${listLayout}`, { error }]">
    <div class="fc-ghost-fill" :style="{ width: `${progress}%` }" />
    <slot name="list" :status-text="statusText" :color="color" />
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

const props = defineProps({
  mode: { type: String as PropType<'grid' | 'list'>, default: 'grid' },
  listLayout: { type: String as PropType<'files' | 'project'>, default: 'files' },
  name: { type: String, required: true },
  ext: { type: String, default: '' },
  isFolder: { type: Boolean, default: false },
  progress: { type: Number, default: 0 },
  done: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  error: { type: Boolean, default: false },
})

const color = computed(() => props.isFolder ? '#8a8fa8' : fileIconColor(props.ext))
const statusText = computed(() => {
  if (props.isFolder) {
    if (props.error) return `${props.done - props.failed}/${props.total}（${props.failed} 个失败）`
    return `${props.done}/${props.total}`
  }
  if (props.error) return '上传失败'
  return `${props.progress}%`
})
</script>

<style scoped>
.fc-ghost {
  position: relative; min-height: 122px; overflow: hidden;
  border-radius: 14px; border: 1.5px dashed rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.04);
  display: flex; flex-direction: column;
  cursor: default; pointer-events: none;
}
.fc-ghost-fill {
  position: absolute; inset: 0; right: auto; height: 100%; pointer-events: none;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--fc-color, rgba(123,127,178,1)) 18%, transparent),
    color-mix(in srgb, var(--fc-color, rgba(123,127,178,1)) 10%, transparent));
  transition: width 0.25s ease-out;
}
.fc-ext-badge {
  position: absolute; top: 10px; left: 10px; z-index: 2;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--fc-color, var(--color-primary)); background: rgba(0,0,0,0.04);
  border-radius: 4px; padding: 2px 5px; line-height: 1.5;
}
.fc-icon-area {
  height: 90px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; overflow: visible;
}
.fc-big-icon {
  color: var(--fc-color, var(--color-primary)); opacity: 0.55;
  transform: translateY(20px); flex-shrink: 0;
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
}
.fc-label { padding: 0 13px 13px; min-width: 0; }
.fc-name {
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }
.fc-ghost .fc-ext-badge { opacity: 0.6; }
.fc-ghost .fc-icon-area { opacity: 0.35; }
.fc-ghost .fc-label { opacity: 0.75; }
.fc-ghost-meta { font-size: 9px; font-weight: 600; color: var(--fc-color, var(--color-primary)); }
.fc-ghost.error { border-color: rgba(200,90,90,0.4); background: rgba(200,90,90,0.04); }
.fc-ghost.error .fc-ghost-fill { background: rgba(200,90,90,0.12); width: 100% !important; }
.fc-ghost.error .fc-ghost-meta { color: rgba(200,90,90,0.85); }

/* list 模式本身就是共享 .list-row：grid、padding、单元格排版全部由 filesListRows.css 拥有。
   这里仅保留上传幽灵自己的进度层/禁交互/弱化视觉，避免项目/文件库再各维护一份列布局。 */
.fc-ghost-row {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(123,127,178,0.2) !important;
  background: rgba(123,127,178,0.03) !important;
  pointer-events: none;
  cursor: default;
}
.fc-ghost-row .fc-ghost-fill {
  position: absolute; inset: 0; right: auto; height: 100%; pointer-events: none;
  background: rgba(123,127,178,0.08);
}
.fc-ghost-row :deep(.lr-name-cell),
.fc-ghost-row :deep(.lr-text),
.fc-ghost-row :deep(.lr-type-cell) { opacity: 0.6; }
.fc-ghost-row.error { border-color: rgba(200,90,90,0.3) !important; }
.fc-ghost-row.error .fc-ghost-fill { background: rgba(200,90,90,0.1); width: 100% !important; }
</style>
