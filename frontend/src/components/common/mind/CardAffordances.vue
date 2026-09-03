<template>
  <div
    class="card-affordances"
    :class="{
      hovering,
      connecting,
      'connection-target': !!targetSide,
      'is-dragging': dragging,
      'is-landing': landing,
      'is-revealing': revealing,
      'is-actions-inline': actionsPlacement === 'inline',
      'is-actions-float': actionsPlacement === 'float',
    }"
    data-card-affordances
    :data-affordances-state="state"
    :data-node-id="nodeId ?? undefined"
  >
    <div v-if="$slots.actions" class="card-affordances__actions card-actions">
      <slot name="actions" />
    </div>

    <span v-if="nodeId !== null" class="card-affordances__connect card-conn-dots" :data-node-id="nodeId">
      <button
        type="button"
        class="conn-dot conn-dot-left"
        :class="{ 'conn-dot-active': targetSide === 'left' }"
        :title="connectTitle"
        @pointerdown.stop="event => emit('connectDragStart', event, 'left')"
      />
      <button
        type="button"
        class="conn-dot conn-dot-right"
        :class="{ 'conn-dot-active': targetSide === 'right' }"
        :title="connectTitle"
        @pointerdown.stop="event => emit('connectDragStart', event, 'right')"
      />
    </span>

    <slot name="connect" />
  </div>
</template>

<script setup lang="ts">
import { computed, toRefs, type PropType } from 'vue'
import { i18n } from '@/i18n'

const props = defineProps({
  hovering: { type: Boolean, default: false },
  connecting: { type: Boolean, default: false },
  targetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  dragging: { type: Boolean, default: false },
  landing: { type: Boolean, default: false },
  revealing: { type: Boolean, default: false },
  nodeId: { type: Number as PropType<number | null>, default: null },
  actionsPlacement: { type: String as PropType<'overlay' | 'inline' | 'float'>, default: 'overlay' },
})

const emit = defineEmits<{
  (event: 'connectDragStart', pointerEvent: PointerEvent, side: 'left' | 'right'): void
}>()
const connectTitle = computed(() => i18n.global.t('sharedUi.connectTitle'))

const state = computed(() => {
  if (props.dragging) return 'dragging'
  if (props.landing) return 'landing'
  if (props.revealing) return 'revealing'
  if (props.connecting) return 'connecting'
  if (props.targetSide) return 'connection-target'
  if (props.hovering) return 'hovering'
  return 'idle'
})

const { hovering, connecting, targetSide, dragging, landing, revealing, nodeId } = toRefs(props)
</script>

<style scoped>
.card-affordances {
  /* 宿主卡片可能用 `.card > *` 给内容统一加 position/z-index；附加交互层必须
     保持以整张卡为参照，否则连接点的 top:50% 会落到内容行而不是卡片中线。 */
  position: absolute !important;
  inset: 0 !important;
  z-index: 20 !important;
  pointer-events: none;
}

/* 连接起点/目标的外围虚线属于 affordance 本身，而不是宿主卡片材质。这样四种画布卡只画
   一份连接反馈，也不会再跟 NoteCard/ProjectCard 各自的 ::before/::after 表面层抢 ownership。
   外扩 4px 后半径同步增加 4px，保证虚线和卡片圆角是同心曲线。 */
.card-affordances.connecting::after,
.card-affordances.connection-target::after {
  content: '';
  position: absolute;
  inset: calc(0px - var(--mind-connection-outline-offset));
  border: var(--mind-connection-outline-width) dashed var(--mind-connection-outline);
  border-radius: calc(var(--mind-canvas-card-radius) + var(--mind-connection-outline-offset));
  corner-shape: round;
  pointer-events: none;
}

.card-affordances.is-actions-inline {
  position: static !important;
  inset: auto !important;
  z-index: auto !important;
  display: contents;
}

.card-affordances__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: flex;
  gap: 3px;
  opacity: 0;
  pointer-events: auto;
  transition: opacity var(--motion-hover-control);
}

.card-affordances.hovering .card-affordances__actions {
  opacity: 1;
}

.card-affordances.is-actions-inline .card-affordances__actions {
  position: static;
  margin-left: auto;
  pointer-events: auto;
}

.card-affordances.is-actions-float .card-affordances__actions {
  top: 11px;
  right: 13px;
}

/* 卡片悬浮操作按钮消费 components/card-actions.css 的跨域契约（.file-card-btn
   同款：实底控制面 + 毛玻璃 + 卡片投影，背景/前景 0.15s 淡入淡出）。文件域按钮
   直接挂类；画布四类卡和 Runtime 克隆的插槽按钮经这里的 :deep 统一取样式，
   两个位置的声明需保持一致，改动契约时两处同步。 */
.card-affordances__actions > :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: var(--control-bg);
  color: var(--control-fg);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  box-shadow: var(--elevation-card);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.card-affordances__actions > :deep(button:hover) {
  background: var(--control-bg-hover);
  color: var(--control-fg-strong);
}

/* 破坏性操作（删除/从画布移除）：与 .file-card-btn.del 同一口径 */
.card-affordances__actions > :deep(button.del:hover),
.card-affordances__actions > :deep(button.danger:hover) {
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

.card-affordances__connect {
  position: absolute !important;
  inset: 0;
  z-index: 20 !important;
  pointer-events: none;
}

.conn-dot {
  position: absolute;
  top: 50%;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: auto;
  transform: translateY(-50%);
  cursor: crosshair;
}

.conn-dot::before {
  content: '';
  position: absolute;
  inset: 10px;
  border: 2px solid var(--mind-connection-dot-border);
  border-radius: 50%;
  background: var(--mind-connection-dot-bg);
  box-shadow: var(--mind-connection-dot-shadow);
  opacity: 0;
  transition: opacity var(--motion-hover-control), transform var(--motion-hover-control), box-shadow var(--motion-hover-control);
}

.card-affordances.hovering .conn-dot::before,
.card-affordances.connecting .conn-dot::before,
.card-affordances.connection-target .conn-dot::before {
  opacity: 1;
}

.card-affordances.connecting .conn-dot::before,
.card-affordances.connection-target .conn-dot::before {
  opacity: var(--mind-connection-dot-muted-opacity);
}

.conn-dot-left { left: -17px; }
.conn-dot-right { right: -17px; }

.conn-dot-active::before {
  opacity: 1 !important;
  transform: scale(1.28);
  box-shadow: 0 0 0 3px var(--mind-connection-dot-ring), var(--mind-connection-dot-shadow);
}

.conn-dot:hover::before {
  opacity: 1;
  transform: scale(1.3);
}

.card-affordances.is-dragging,
.card-affordances.is-landing,
.card-affordances.is-revealing {
  pointer-events: none;
  opacity: 0;
}

/* Runtime 通过临时类管理跨 Vue 克隆的附加交互。inline 模式使用 display:contents，
   所以隐藏根节点本身不可靠，必须直接压制其子按钮和连接点；卡片主体视觉不受影响。 */
:global(.runtime-affordances-hidden) {
  pointer-events: none !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
}

:global(.runtime-affordances-hidden) > * {
  pointer-events: none !important;
  opacity: 0 !important;
  transition: opacity 0.15s ease !important;
}

/* inline 模式的根节点是 display:contents，不参与绘制；子节点必须单独承担淡出。 */
:global([data-card-affordances] > *) {
  transition: opacity 0.15s ease;
}
</style>
