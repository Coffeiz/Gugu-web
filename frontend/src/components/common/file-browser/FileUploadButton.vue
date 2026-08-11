<template>
  <label class="fub" :class="[mode, { dragging }]">
    <PhUploadSimple :size="mode === 'grid' ? 16 : 13" weight="bold" />
    <span class="fub-text">上传文件</span>
    <input type="file" hidden multiple @change="emit('select', $event)" />
  </label>
</template>

<script setup lang="ts">
/**
 * 文件库网格/列表和项目文件区网格/列表共用的上传入口——之前四处各画一份（文件库列表甚至
 * 漏画了），图标大小、文字包裹方式、hover 颜色都不一致。上传拖拽悬停态（dragging）由调用方
 * 的上传流程管理，这里只负责按 mode 呈现网格卡片式还是列表行式外观；
 * dragover/dragleave/drop 走原生事件透传，调用方直接在 <FileUploadButton> 标签上绑定即可。
 */
import { PhUploadSimple } from '@phosphor-icons/vue'

defineProps({
  mode: { type: String as () => 'grid' | 'list', default: 'grid' },
  dragging: { type: Boolean, default: false },
})
const emit = defineEmits<{ select: [e: Event] }>()
</script>

<style scoped>
.fub { cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); }

.fub.grid {
  border: 1.5px dashed rgba(0,0,0,0.09);
  /* 文件/文件夹卡片的实际网格行高约为 132.86px（90px 内容区加标签区）。
     上传入口与卡片同属 Grid 行且参与 Runtime FLIP，低于行高会在底部拖拽时
     让 scrollHeight 少几个像素，浏览器随即把 scrollTop clamp 到更小的值。 */
  border-radius: 14px; corner-shape: round; overflow: hidden; min-height: 133px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 7px;
  font-size: 10px; font-weight: 600;
  background: rgba(255,255,255,0.2); transition: all 0.18s;
}
.fub.grid:hover, .fub.grid.dragging {
  border-color: rgba(123,127,178,0.45);
  color: var(--color-primary); background: rgba(123,127,178,0.04);
}

.fub.list {
  display: flex; align-items: center; gap: 7px; padding: 9px 10px;
  min-height: 42px; box-sizing: border-box;
  font-size: 12px; border-radius: var(--radius-sm);
  border: 1px dashed transparent; transition: background 0.12s;
}
.fub.list:hover, .fub.list.dragging {
  background: rgba(123,127,178,0.05); border-color: rgba(123,127,178,0.3); color: var(--color-primary);
}
.fub.list .fub-text { font-weight: 600; }
</style>
