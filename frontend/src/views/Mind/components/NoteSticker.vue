<template>
  <article
    class="note-sticker hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide, tombstone: !!item.node.deletedAt }"
    :style="stickerStyle"
    :data-node-id="item.nodeId"
    @pointerdown.stop="onPointerDown"
    @mouseenter="emit('hover', item, true)"
    @mouseleave="emit('hover', item, false)"
  >
    <template v-if="editing">
      <input
        ref="titleInputRef"
        v-model="draftTitle"
        class="ns-title-input"
        placeholder="便签标题"
        @pointerdown.stop
        @keydown.enter.prevent="contentRef?.focus()"
        @blur="onBlur"
      />
      <textarea
        ref="contentRef"
        v-model="draftContent"
        class="ns-content-input"
        placeholder="写点什么…"
        @pointerdown.stop
        @blur="onBlur"
      ></textarea>
    </template>
    <template v-else>
      <h3>{{ title }}</h3>
      <div class="ns-content" v-html="preview"></div>
      <span v-if="item.node.deletedAt" class="ns-deleted">已删除</span>
      <!-- 便签不再弹右侧详情栏管理删除，直接在贴纸角上给一个悬停按钮（同「最近文件」
           卡片 .fc-hover-actions 的悬停显隐手感）。建立关联改成边缘两个圆点拖出连线，
           不再是点按钮进入"选目标"模式（见 conn-dot，松手交给 MindCanvas.vue 判定落点）。 -->
      <div v-if="!item.node.deletedAt" class="ns-actions">
        <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)">
          <PhTrash :size="12" weight="bold" />
        </button>
      </div>
      <button v-if="!item.node.deletedAt" class="conn-dot conn-dot-left" :class="{ 'conn-dot-active': connectionTargetSide === 'left' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e, 'left')"></button>
      <button v-if="!item.node.deletedAt" class="conn-dot conn-dot-right" :class="{ 'conn-dot-active': connectionTargetSide === 'right' }" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e, 'right')"></button>
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, type PropType } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import { useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'
import { mdToPreviewHtml, splitMindTitleBody } from '@/composables/useMindEditor'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  // 画布相机当前缩放（MindCanvas.vue 的 camera.scale）——拖拽克隆脱离 .canvas-world 的
  // transform:scale 祖先后要自己补回视觉缩放，见 usePhysicsDrag.ts 的 contentScale。
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'dragging', item: MindCanvasItem, x: number, y: number): void
  (e: 'landing', item: MindCanvasItem, x: number, y: number): void
  (e: 'landingDone', item: MindCanvasItem): void
  (e: 'moved', item: MindCanvasItem, x: number, y: number): void
  (e: 'save', fields: { title: string; contentMd: string }): void
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

const split = computed(() => splitMindTitleBody(props.item.node.contentMd))
const title = computed(() => split.value.titleRaw || props.item.node.title || '未命名便签')
const preview = computed(() => mdToPreviewHtml(split.value.body || props.item.node.contentMd || ''))
const stickerStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})

const editing = ref(false)
const draftTitle = ref('')
const draftContent = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)
const contentRef = ref<HTMLTextAreaElement | null>(null)

async function startEdit() {
  if (props.item.node.deletedAt) return
  draftTitle.value = props.item.node.title || ''
  draftContent.value = props.item.node.contentMd || ''
  editing.value = true
  await nextTick()
  titleInputRef.value?.focus()
}
// 标题/正文两个输入框之间切焦点也会触发各自的 blur——下一帧再判断焦点是否仍留在贴纸内，
// 真正失焦（点了贴纸外面）才提交退出，避免 Tab/点击切换输入框时误提前退出编辑态。
function onBlur() {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active === titleInputRef.value || active === contentRef.value) return
    editing.value = false
    emit('save', { title: draftTitle.value, contentMd: draftContent.value })
  })
}

// 单击直接进编辑；按住不放越过阈值才起真正的拖拽物理，两者靠 useCardDrag 的位移阈值区分，
// 不需要 dblclick。
const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  onClick: () => { if (!editing.value) startEdit() },
  // 拖动中实时更新（不落库，只为了让连着这张贴纸的关系线跟手同步移动，见 MindCanvas.vue
  // 的 onItemDragging）；松手时卡片中心落在鼠标下，不延续抓取时的偏移——从任意一角抓起，
  // 松手都一样，两处用同一套居中公式。
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
/* 纸条质感：半不透明纸色、短阴影、普通小圆角（不是大面板的 squircle）——
   跟系统对象贴纸（走玻璃卡语言）刻意区分开，见设计草案「视觉与布局」。 */
.note-sticker {
  position: absolute; box-sizing: border-box; padding: 16px 17px 14px;
  border: 1px solid rgba(255,255,255,0.78); border-radius: 10px;
  background: rgba(255,252,238,0.92);
  /* 静止态阴影本体跟文件/项目卡统一（0 2px 8px rgba(80,90,110,.07)，见 .proj-card），
     只叠加纸条自己的内高光——之前这里各写各的深浅/色相，四种贴纸摆一起静止时阴影就
     看着不像同一套材质语言。 */
  box-shadow: 0 2px 8px rgba(80,90,110,0.07), inset 0 1px 0 rgba(255,255,255,0.9);
  color: var(--text-primary); cursor: pointer; user-select: none; touch-action: none;
}
/* 悬浮抬起动效跟文件卡/项目卡统一走 .hover-card-fx（见 global.css），不再各写一份——
   之前这里只有 box-shadow 加深、没有 translateY 位移，四种贴纸手感不一致。这里也不能像
   之前那样自带一份 transition：scoped 属性选择器会让它盖过 .hover-card-fx 的 transition，
   把 transform 部分覆盖掉，悬浮抬起会瞬间跳变、不是平滑过渡。
   悬停阴影单独覆盖一份（不留给 .hover-card-fx 的默认值）：跟 .fc-card:hover 同款做法——
   共享阴影本体（0 6px 18px .13，同一个"抬起后浮空"的量），叠加纸条自己的内高光
   （inset 0 1px 0），不然悬停时会丢掉静止态就有的那圈纸张高光，阴影质感和文件卡对不上。
   这条规则的 specificity 天然高于全局 .hover-card-fx（带 data-v 属性选择器），只覆盖
   box-shadow 这一个值，transition 本身仍由 .hover-card-fx 统一提供。 */
.note-sticker:hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13), inset 0 1px 0 rgba(255,255,255,0.95); }
.note-sticker.connecting { border-style: dashed; }
.note-sticker.tombstone { opacity: .55; filter: grayscale(.45); }
h3 { margin: 0 0 8px; font-size: 14px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; }
.ns-content { max-height: 92px; overflow: hidden; color: var(--text-secondary); font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
.ns-content :deep(*) { margin: 0; }
.ns-content :deep(* + *) { margin-top: .2em; }
.ns-deleted { display: block; margin-top: 8px; color: var(--text-secondary); font-size: 11px; }
.ns-title-input {
  width: 100%; margin: 0 0 8px; padding: 0; border: 0; outline: 0; background: transparent;
  color: var(--text-primary); font: inherit; font-size: 14px; font-weight: 700; cursor: text;
}
.ns-content-input {
  width: 100%; min-height: 80px; padding: 0; border: 0; outline: 0; resize: none; background: transparent;
  color: var(--text-secondary); font: inherit; font-size: 12.5px; line-height: 1.55; cursor: text;
}
.ns-title-input::placeholder, .ns-content-input::placeholder { color: var(--text-secondary); opacity: .58; }

.ns-actions {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.note-sticker:hover .ns-actions { opacity: 1; }
.ns-actions button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border: 0; border-radius: 5px;
  background: rgba(255,255,255,0.7); color: var(--text-secondary); cursor: pointer;
}
.ns-actions button:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }

/* 边缘连接点：贴纸左右两侧各一颗，悬停贴纸才显形，按住拖出去落到另一张贴纸上就建立关联
   （见 MindCanvas.vue 的 onConnectDragStart，整个拖拽判定都在那边，这里只管发起）。 */
.conn-dot {
  position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px;
  border: 2px solid #fff; border-radius: 50%; padding: 0;
  background: var(--color-primary); box-shadow: 0 1px 4px rgba(80,90,110,.35);
  opacity: 0; transition: opacity 0.15s, transform 0.15s; cursor: crosshair; z-index: 6;
}
.note-sticker:hover .conn-dot { opacity: 1; }
.note-sticker.connecting .conn-dot, .note-sticker.connection-target .conn-dot { opacity: .38; }
.note-sticker.connection-target .conn-dot-active { opacity: 1; transform: scale(1.28); animation: conn-dot-magnet .44s cubic-bezier(.22, 1.35, .36, 1) infinite alternate; }
.conn-dot:hover { transform: scale(1.3); }
.conn-dot-left { left: -6px; }
.conn-dot-right { right: -6px; }
@keyframes conn-dot-magnet { from { box-shadow: 0 1px 4px rgba(80,90,110,.35); } to { box-shadow: 0 0 0 5px rgba(123,127,178,.16), 0 2px 8px rgba(80,90,110,.38); } }
</style>
