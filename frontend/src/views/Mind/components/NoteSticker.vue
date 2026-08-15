<template>
  <!-- 画布便签直接复用 NoteCard.vue 本体——跟笔记页时间流里的便签走同一份显示/编辑逻辑
       （标题+分割线+正文、展开/收起、富文本编辑器、待办勾选、自定义颜色），不再各写一套。
       这层壳只负责画布特有的东西：世界坐标定位、拖拽、建立关联的连接点。 -->
  <div
    class="canvas-note-wrap"
    :class="{ tombstone: !!item.node.deletedAt }"
    :style="stickerStyle"
    :data-node-id="item.nodeId"
    @pointerdown.stop="onPointerDown"
    @mouseenter="onPointerEnter"
    @mouseleave="onPointerLeave"
  >
    <!-- 连接点现在渲染在 NoteCard.vue 内部（canvasMode 才有），不是这层壳的兄弟节点——
         拖拽克隆走的是 cloneNode(true)，只会拷贝 NoteCard 自己的子树；连接点若留在壳上
         （NoteCard 的兄弟），飞的克隆体里根本不含它，画面上看起来"便签抛出去的时候没有
         连接点，其它卡片都有"，松手落地那一刻壳上真实的连接点（z-index 比克隆低）又会被
         尚未淡出的克隆体正面盖住，变成"连接点飞到克隆后面"——两个反馈根子都在这，挪进
         NoteCard 内部后连接点就是克隆的真子集，跟其它三种卡片同样的路数。 -->
    <NoteCard
      ref="cardRef"
      class="canvas-note-card"
      :note="item.node"
      :editing="editing"
      :highlight="false"
      :conflict="conflict"
      :canvas-mode="true"
      :scale="scale"
      :connecting="connecting"
      :connection-target-side="connectionTargetSide"
      @edit="editing = true"
      @close="editing = false"
      @save="onSaveMd"
      @delete="emit('remove', item)"
      @color="onColor"
      @toggle-task="onToggleTask"
      @connect-drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { toggleTaskInMd } from '@/composables/useMindEditor'
import { useMindRuntimeObject } from '../composables/useMindRuntimeObject'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'
import { itemSize } from '@/composables/useMindCanvas'
import { MindConflictError, useMindStore } from '@/stores/mind'
import { showAppError } from '@/composables/useAppToast'
import type { MindCanvasItem } from '@/services/api'
import NoteCard from './NoteCard.vue'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  // 画布相机当前缩放（MindCanvas.vue 的 camera.scale）——拖拽克隆脱离 .canvas-world 的
  // transform:scale 祖先后的视觉补偿由画布 Surface camera 统一提供给 Runtime。
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
}>()

const store = useMindStore()

// 宽度仍是画布视图状态的一部分（用户没法在便签内容里"撑宽"，只有默认值/以后可能加的手动
// 拖边调整）；高度不再从 itemSize 取——NoteCard 自己按标题+正文自然撑高，跟项目/文件
// 引用卡是同一个道理（见 ProjectRefCard.vue/FileRefCard.vue 的 ResizeObserver 上报）。
// 但 .canvas-note-wrap 自己不能留成"高度全靠 NoteCard 撑起来"的纯 auto：拖拽期间
// runtime 把 NoteCard（sourceEl）隐藏直至落地飞行动画整个播完
// （~0.55s），这段时间里 wrap 唯一的正常流子元素消失，auto 高度直接塌成 0——而
// conn-dot 是 wrap 的绝对定位子元素、top:50% 参照的正是 wrap 自身高度，塌成 0 后两颗
// 连接点全部被钉在顶部，揭示 NoteCard 那一刻高度瞬间恢复，两颗点跟着从顶部猛地"弹"到
// 真正的垂直居中——即用户反馈的"连接节点从上向下飞出"。这里用 ResizeObserver 量到的
// 最近一次真实高度显式钉住 wrap 的 height，不再让它随 NoteCard 的显隐塌陷。
const lastCardH = ref<number | null>(null)
const stickerStyle = computed(() => {
  const { w } = itemSize(props.item)
  const style: Record<string, string> = { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}` }
  if (lastCardH.value != null) style.height = `${lastCardH.value}px`
  return style
})

const editing = ref(false)
const conflict = ref(false)
// 关系线与连接点不能只看浏览器的 :hover：编辑态会主动撤掉卡片的 hover-card-fx，鼠标却仍
// 在卡片内。把「视觉上允许 hover」收成同一状态源，进入编辑立即熄灭，退出时若鼠标未移开则
// 自然恢复，连线端点、圆点和卡片抬起不会再各走各的。
const pointerHover = ref(false)
const interactionHover = computed(() =>
  pointerHover.value && !editing.value && !props.item.node.deletedAt,
)
function onPointerEnter() { pointerHover.value = true }
function onPointerLeave() { pointerHover.value = false }
watch(interactionHover, hovering => emit('hover', props.item, hovering), { immediate: true })

const cardRef = ref<InstanceType<typeof NoteCard> | null>(null)
function noteCardEl() {
  return cardRef.value?.rootEl ?? null
}
let cardResizeObserver: ResizeObserver | null = null
function emitMeasuredSize() {
  const card = noteCardEl()
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  // wrap 的 left/top/width 都是世界坐标（外层 .canvas-world 自带 camera.scale 的 transform，
  // 浏览器会自动把这些世界坐标值渲染缩放到屏幕上）——这里钉住的 height 必须跟 width 是
  // 同一套单位，否则画布缩放到非 1 倍时，「世界坐标宽度」配「屏幕像素高度」会显式撑出一个
  // 比例失真的 wrap。除回 scale 换算成世界坐标高度，跟下面 emit 给 measured 的换算一致。
  lastCardH.value = rect.height / scale
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = noteCardEl()
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => nextTick(observeCard))
// NoteCard 编辑/预览切换、展开/收起、字数变化都会改高度，同一个 ResizeObserver 全部接住，
// 不用像宽度那样另外挂 watch。
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => {
  cardResizeObserver?.disconnect()
  emit('hover', props.item, false)
})

async function onSaveMd(md: string) {
  try {
    await store.updateCanvasNote(props.item.nodeId, { contentMd: md })
    conflict.value = false
  } catch (e) {
    if (e instanceof MindConflictError) {
      conflict.value = true
      await store.loadCanvas(props.item.canvasId)   // 拉这张画布的最新数据，别覆盖别人的改动
    }
  }
}
async function onToggleTask(idx: number) {
  await onSaveMd(toggleTaskInMd(props.item.node.contentMd, idx))
}
async function onColor(color: string | null) {
  try {
    await store.updateCanvasNote(props.item.nodeId, { color })
  } catch (e) {
    // updateCanvasNote 现在加了乐观更新——UI 已经先按新色显示了，如果 PATCH 失败
    // 还要静默吞掉，用户就会看到「点了变色但其实没存上」的不一致。把错误交给全局
    // toast 提示，同时让用户能感知到这次改动需要重试或刷新。MindConflictError 也
    // 走这里（409 在 store 层抛），跟 updateNote 路径同款处理。
    showAppError(e)
  }
}

// 点便签本体进编辑态、点标题/正文里的待办/引用/展开按钮等都是 NoteCard 自己处理
// （见其 onBodyClick/startEditAt），这里的拖拽只处理"按住越过阈值"的真正拖拽；
// NoteCard 内部所有可交互元素都挂了 @pointerdown.stop，不会被这层拖拽阈值判定抢走。
const { onPointerDown } = useMindRuntimeObject({
  objectId: () => mindCanvasObjectId(props.item),
  element: noteCardEl,
})
</script>

<style scoped>
.canvas-note-wrap { position: absolute; box-sizing: border-box; }
.canvas-note-wrap.tombstone { opacity: .55; filter: grayscale(.45); }
/* NoteCard 自己的静止/悬停阴影跟文件/项目卡已经是同一套语言（见其样式注释），画布场景
   不用再叠一份；"正在建立关联"的虚线描边现在是 global.css 的共用 .connecting 规则，
   这里也不用再单独声明一份。 */

/* 连接点挪进了共用组件 CardAffordances.vue，外观/悬停显形逻辑不再自己抄一份。 */
</style>
