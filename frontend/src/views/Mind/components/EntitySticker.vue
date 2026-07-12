<template>
  <article
    class="entity-sticker glass-card hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide, tombstone: !!item.node.deletedAt }"
    :style="stickerStyle"
    :data-node-id="item.nodeId"
    @pointerdown.stop="onPointerDown"
    @mouseenter="emit('hover', item, true)"
    @mouseleave="emit('hover', item, false)"
  >
    <div class="es-head">
      <component :is="icon" :size="15" weight="bold" />
      <span class="es-kind">{{ label }}</span>
    </div>
    <h3>{{ title }}</h3>
    <span v-if="item.node.deletedAt" class="es-deleted">已删除</span>
    <span v-else class="es-hint">点击打开原对象</span>
    <div v-if="!item.node.deletedAt" class="es-actions">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </div>
    <button v-if="!item.node.deletedAt" class="conn-dot conn-dot-left" :class="{ 'conn-dot-active': connectionTargetSide === 'left' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e, 'left')"></button>
    <button v-if="!item.node.deletedAt" class="conn-dot conn-dot-right" :class="{ 'conn-dot-active': connectionTargetSide === 'right' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e, 'right')"></button>
  </article>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { PhCalendarBlank, PhFile, PhStack, PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import { useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'dragging', item: MindCanvasItem, x: number, y: number): void
  (e: 'landing', item: MindCanvasItem, x: number, y: number): void
  (e: 'landingDone', item: MindCanvasItem): void
  (e: 'moved', item: MindCanvasItem, x: number, y: number): void
  (e: 'open', item: MindCanvasItem): void
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

// 图标/文案与顶栏全局搜索、侧边栏导航保持一致（PhStack=项目、PhFile=文件、PhCalendarBlank=活动）。
// 项目/文件已各自拆成 ProjectRefCard.vue/FileRefCard.vue（原生卡片视觉），这里只剩活动。
const TYPE_ICON = { project: PhStack, file: PhFile, event: PhCalendarBlank } as const
const TYPE_LABEL = { project: '项目', file: '文件', event: '活动' } as const
const refType = computed(() => props.item.node.refType || 'event')
const icon = computed(() => TYPE_ICON[refType.value as keyof typeof TYPE_ICON] || PhCalendarBlank)
const label = computed(() => TYPE_LABEL[refType.value as keyof typeof TYPE_LABEL] || '对象')
const title = computed(() => props.item.node.title || '未命名对象')
const stickerStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})

const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  onClick: () => { if (!props.item.node.deletedAt) emit('open', props.item) },
  onDragMove: (worldX, worldY) => {
    emit('dragging', props.item, worldX, worldY)
  },
  onLanding: (worldX, worldY) => {
    emit('landing', props.item, worldX, worldY)
  },
  onLandingDone: () => emit('landingDone', props.item),
  onDropAt: (worldX, worldY) => {
    emit('moved', props.item, worldX, worldY)
  },
})
</script>

<style scoped>
/* 系统对象贴纸沿用现有玻璃卡语言（同 .glass-card），刻意跟纸条便签（NoteSticker.vue）
   区分开——"纸条表示人的思考，玻璃表示系统中的真实对象"，见设计草案「视觉与布局」。 */
.entity-sticker {
  position: absolute; box-sizing: border-box; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 6px;
  cursor: pointer; user-select: none; touch-action: none;
  /* 悬浮抬起动效走 .hover-card-fx（见 global.css，跟文件/项目卡同一套时长/缓动），但这里
     还套了 .glass-card——它自己也声明了一份 transition（background/box-shadow），跟
     .hover-card-fx 的 transition 特异度相同，最终生效的是样式表里排在后面那条，会整个
     覆盖掉（不是合并），把 transform 那部分连带吃掉，悬浮抬起变成瞬间跳变。这里在 scoped
     规则里把两边都要的属性合并声明一份完整的（transform 数值抄 .hover-card-fx，background
     抄 .glass-card），靠 scoped 属性选择器的更高特异度稳赢，不依赖两个全局类在样式表里
     谁先谁后。 */
  transition: transform 0.25s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.25s ease, background 0.25s ease;
  /* 静止态阴影本体跟文件/项目卡统一（0 2px 8px rgba(80,90,110,.07)，见 .proj-card），不用
     .glass-card 默认的 --glass-shadow（那份是给工具条/侧栏这类"浮层面板"用的，深浅跟卡片
     不是一回事）——四种贴纸摆一起静止时才不会看出深浅不一样。玻璃质感（内高光/描边）仍
     由 .glass-card 提供，这里只覆盖投影本体。 */
  box-shadow: 0 2px 8px rgba(80,90,110,0.07), inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55);
}
.entity-sticker:hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.entity-sticker.connecting { border-style: dashed; }
.entity-sticker.tombstone { opacity: .55; filter: grayscale(.45); }
.es-head { display: flex; align-items: center; gap: 6px; color: var(--color-primary); }
.es-kind { font-size: 10px; font-weight: 700; }
h3 { margin: 0; font-size: 13.5px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; color: var(--text-primary); }
.es-hint, .es-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

.es-actions { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.entity-sticker:hover .es-actions { opacity: 1; }
.es-actions button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: 5px; background: rgba(255,255,255,0.7); color: var(--text-secondary); cursor: pointer; }
.es-actions button:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }

.conn-dot {
  position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px;
  border: 2px solid #fff; border-radius: 50%; padding: 0;
  background: var(--color-primary); box-shadow: 0 1px 4px rgba(80,90,110,.35);
  opacity: 0; transition: opacity 0.15s, transform 0.15s; cursor: crosshair; z-index: 6;
}
.entity-sticker:hover .conn-dot { opacity: 1; }
.entity-sticker.connecting .conn-dot, .entity-sticker.connection-target .conn-dot { opacity: .38; }
.entity-sticker.connection-target .conn-dot-active { opacity: 1; transform: scale(1.28); animation: conn-dot-magnet .44s cubic-bezier(.22, 1.35, .36, 1) infinite alternate; }
.conn-dot:hover { transform: scale(1.3); }
.conn-dot-left { left: -6px; }
.conn-dot-right { right: -6px; }
@keyframes conn-dot-magnet { from { box-shadow: 0 1px 4px rgba(80,90,110,.35); } to { box-shadow: 0 0 0 5px rgba(123,127,178,.16), 0 2px 8px rgba(80,90,110,.38); } }
</style>
