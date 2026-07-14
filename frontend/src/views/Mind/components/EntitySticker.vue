<template>
  <article
    ref="cardRef"
    class="entity-sticker glass-card hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide, tombstone: isTombstone }"
    :style="stickerStyle"
    :data-node-id="item.nodeId"
    @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <div class="es-head">
      <component :is="icon" :size="15" weight="bold" />
      <span class="es-kind">{{ label }}</span>
    </div>
    <h3>{{ title }}</h3>
    <span v-if="isTombstone" class="es-deleted">已删除，仅保留快照</span>
    <template v-else>
      <p v-if="eventDisplay?.description" class="es-desc">{{ eventDisplay.description }}</p>
      <span v-if="eventTimeLabel" class="es-time">
        <PhClock :size="11" weight="bold" />{{ eventTimeLabel }}
      </span>
    </template>
    <CardActions v-if="!isTombstone" :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      v-if="!isTombstone"
      :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhCalendarBlank, PhClock, PhFile, PhStack, PhTrash } from '@phosphor-icons/vue'
import { eventsApi, type MindCanvasItem } from '@/services/api'
import { useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'
import CardActions from './CardActions.vue'
import CardConnDot from './CardConnDot.vue'

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
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
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

// 画布 items 响应已携带活动首屏快照，刷新时直接用它渲染，避免每张活动卡挂载后再单条请求、
// 先按标题量一次高度又因描述/日期回来二次撑高。旧服务响应或缺少快照时才回退详情请求。
const event = ref<Awaited<ReturnType<typeof eventsApi.get>> | null>(null)
const missingEvent = ref(false)
const isTombstone = computed(() => !!props.item.node.deletedAt || missingEvent.value)
const eventDisplay = computed(() => event.value ?? props.item.refData ?? null)
async function loadEvent() {
  const refId = props.item.node.refId
  missingEvent.value = false
  if (props.item.node.deletedAt || refType.value !== 'event' || refId == null) { event.value = null; return }
  if (props.item.refData?.date) { event.value = null; return }
  try {
    event.value = await eventsApi.get(refId)
  } catch (error) {
    event.value = null   // 原对象可能已被删除，静默失败即可——标题快照仍然显示，不阻断画布使用
    missingEvent.value = (error as { status?: number }).status === 404
  }
}
onMounted(loadEvent)
watch(() => props.item.node.refId, loadEvent)

// date/time 是 "YYYY-MM-DD"/"HH:MM" 纯字符串（后端 CalendarEvent 模型），不是要按时区解析的
// ISO 时间戳，日历页自己也是这么就地拼字符串显示（没有现成的导出工具函数可复用）。
// time 为空＝全天活动。
const eventTimeLabel = computed(() => {
  const e = eventDisplay.value
  if (!e?.date) return ''
  const d = new Date(`${e.date}T00:00:00`)
  const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`
  if (!e.time) return `${dateStr} 全天`
  return `${dateStr} ${e.time}${e.endTime ? `–${e.endTime}` : ''}`
})

// CardActions/CardConnDot 用 prop 驱动外观（不是 CSS :hover），所以这里要自己记一份悬停
// 状态——反正 mouseenter/mouseleave 本来就要往上报给 MindCanvas.vue（连线抬起效果），
// 顺手多存一份本地状态不算额外开销。
const isHovering = ref(false)
function onEnter() { isHovering.value = true; emit('hover', props.item, true) }
function onLeave() { isHovering.value = false; emit('hover', props.item, false) }

const cardRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
function emitMeasuredSize() {
  const card = cardRef.value
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = cardRef.value
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => nextTick(observeCard))
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())

const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  getDragEl: () => cardRef.value,
  onClick: () => { if (!isTombstone.value) emit('open', props.item) },
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
  /* 活动贴纸和项目/文件贴纸属于同一层画布卡片，统一普通 14px 圆角；不继承 glass-card
     给大面板使用的 18px squircle，避免同一画布出现三种曲率。 */
  border-radius: var(--radius-md);
  corner-shape: initial;
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
/* "正在建立关联"的虚线描边走 global.css 共用的 .connecting 规则，不再各卡自己声明一份。 */
.entity-sticker.tombstone { opacity: .55; filter: grayscale(.45); }
.es-head { display: flex; align-items: center; gap: 6px; color: var(--color-primary); }
.es-kind { font-size: 10px; font-weight: 700; }
h3 { margin: 0; font-size: 13.5px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; color: var(--text-primary); }
.es-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }
/* 描述最多留 3 行——活动描述长短不定，画布卡片不该跟着无限撑高，clamp 之后配合下面
   ResizeObserver 上报的实测尺寸，连线锚点/拖拽落点始终对得上卡片真实渲染大小。
   margin-top 用负值：父级 flex gap（6px）+ h3 自己 1.35 行高在文字下方留的行间距、
   加上这里 1.5 行高在文字上方留的行间距，三层叠在一起让标题到正文的视觉间隙比其它
   贴纸的"标题—正文"间距明显大一截，用负 margin 啃掉一部分行高留白，肉眼对齐其它卡片。 */
.es-desc {
  margin: -3px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.es-time {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; color: var(--text-secondary); opacity: .85;
}

/* 操作按钮（.card-actions）和连接点（.conn-dot）都挪进了共用组件 CardActions.vue/
   CardConnDot.vue，外观/悬停显形逻辑不再各卡自己抄一份。 */
</style>
