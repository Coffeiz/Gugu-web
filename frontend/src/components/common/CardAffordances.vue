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
        title="拖出连线建立关联"
        @pointerdown.stop="event => emit('connectDragStart', event, 'left')"
      />
      <button
        type="button"
        class="conn-dot conn-dot-right"
        :class="{ 'conn-dot-active': targetSide === 'right' }"
        title="拖出连线建立关联"
        @pointerdown.stop="event => emit('connectDragStart', event, 'right')"
      />
    </span>

    <slot name="connect" />
  </div>
</template>

<script setup lang="ts">
import { computed, toRefs, type PropType } from 'vue'

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
  transition: opacity 0.15s;
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

.card-affordances__actions > :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.card-affordances__actions > :deep(button:hover) {
  background: rgba(123, 127, 178, 0.16);
  color: var(--color-primary);
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
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--color-primary, #7b7fb2);
  box-shadow: 0 1px 4px rgba(30, 35, 60, 0.25);
  opacity: 0;
  transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
}

.card-affordances.hovering .conn-dot::before,
.card-affordances.connecting .conn-dot::before,
.card-affordances.connection-target .conn-dot::before {
  opacity: 1;
}

.card-affordances.connecting .conn-dot::before,
.card-affordances.connection-target .conn-dot::before {
  opacity: 0.38;
}

.conn-dot-left { left: -17px; }
.conn-dot-right { right: -17px; }

.conn-dot-active::before {
  opacity: 1 !important;
  transform: scale(1.28);
  box-shadow: 0 0 0 3px rgba(123, 127, 178, 0.22), 0 1px 5px rgba(30, 35, 60, 0.3);
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

/* 拖拽系统把生命周期投影成稳定的 DOM class。附加交互在抓起、landing 和 regrab
   期间必须统一失效，避免按钮/连接点从克隆体或落地目标中闪出；揭示完成后由本体
   自己恢复 hover 显示。 */
:global(.phys-drag-clone) .card-affordances,
:global(.phys-landing-content) .card-affordances,
:global(.phys-drag-source) .card-affordances,
:global(.phys-drag-source-placeholder) .card-affordances {
  pointer-events: none !important;
  opacity: 0 !important;
}

/* Runtime 通过临时类管理跨 Vue 克隆的附加交互。inline 模式使用 display:contents，
   所以隐藏根节点本身不可靠，必须直接压制其子按钮和连接点；卡片主体视觉不受影响。 */
:global(.runtime-affordances-hidden) {
  pointer-events: none !important;
  opacity: 0 !important;
  visibility: hidden !important;
}

:global(.runtime-affordances-hidden) > * {
  pointer-events: none !important;
  opacity: 0 !important;
  visibility: hidden !important;
}
</style>
