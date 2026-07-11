<template>
  <article
    class="canvas-sticker"
    :class="{ selected, connecting, ref: item.node.kind === 'ref', tombstone: !!item.node.deletedAt }"
    :style="stickerStyle"
    @pointerdown.stop="emit('dragStart', $event, item)"
    @click.stop="emit('select', item)"
  >
    <span v-if="item.node.kind === 'ref'" class="cs-kind">{{ refLabel }}</span>
    <h3>{{ title }}</h3>
    <div class="cs-content" v-html="preview"></div>
    <span v-if="item.node.deletedAt" class="cs-deleted">已删除</span>
  </article>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import type { MindCanvasItem } from '@/services/api'
import { mdToPreviewHtml, splitMindTitleBody } from '@/composables/useMindEditor'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  selected: { type: Boolean, default: false },
  connecting: { type: Boolean, default: false },
})
const emit = defineEmits<{
  (e: 'select', item: MindCanvasItem): void
  (e: 'dragStart', event: PointerEvent, item: MindCanvasItem): void
}>()

const split = computed(() => splitMindTitleBody(props.item.node.contentMd))
const title = computed(() => {
  if (props.item.node.deletedAt) return props.item.node.title || '已删除的便签'
  return split.value.titleRaw || props.item.node.title || (props.item.node.kind === 'ref' ? '未命名对象' : '未命名便签')
})
const preview = computed(() => mdToPreviewHtml(split.value.body || props.item.node.contentMd || ''))
const refLabel = computed(() => ({ project: '项目', file: '文件', event: '活动' }[props.item.node.refType || ''] || '对象'))
const stickerStyle = computed(() => ({
  left: `${props.item.x}px`,
  top: `${props.item.y}px`,
  width: `${props.item.w || 244}px`,
  minHeight: `${props.item.h || 148}px`,
  zIndex: `${props.item.z}`,
}))

</script>

<style scoped>
.canvas-sticker {
  position: absolute; box-sizing: border-box; padding: 16px 17px 14px;
  border: 1px solid rgba(255,255,255,0.78); border-radius: 12px;
  background: rgba(255,252,238,0.88); box-shadow: 0 8px 18px rgba(65,70,90,0.16), inset 0 1px 0 rgba(255,255,255,0.9);
  color: var(--text-primary); cursor: grab; user-select: none; touch-action: none;
  transform-origin: center center; transition: box-shadow .18s ease, border-color .18s ease;
}
.canvas-sticker:hover { box-shadow: 0 12px 24px rgba(65,70,90,0.2), inset 0 1px 0 rgba(255,255,255,0.95); }
.canvas-sticker.selected { border-color: rgba(123,127,178,0.8); box-shadow: 0 0 0 3px rgba(123,127,178,0.18), 0 12px 24px rgba(65,70,90,0.2); }
.canvas-sticker.connecting { border-style: dashed; }
.canvas-sticker.ref { background: rgba(255,255,255,0.52); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.canvas-sticker.tombstone { opacity: .55; filter: grayscale(.45); }
.cs-kind { display: inline-flex; margin-bottom: 7px; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
h3 { margin: 0 0 8px; font-size: 14px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; }
.cs-content { max-height: 92px; overflow: hidden; color: var(--text-secondary); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
.cs-content :deep(*) { margin: 0; }
.cs-content :deep(* + *) { margin-top: .2em; }
.cs-deleted { display: block; margin-top: 8px; color: var(--text-secondary); font-size: 11px; }
</style>
