<template>
  <!-- 画布项目引用卡不再嵌 ProjectCard.vue 本体——看板项目卡承载了大量看板专属交互（优先级
       星级、推进阶段按钮、点阶段名弹待办列表、文件拖拽上传），画布这边只需要一份只读展示 +
       拖拽/建立关联，共享整个交互组件换来的是"看板改需求容易带崩画布、画布改样式容易带崩
       看板"（这次 squircle 圆角+加宽的误伤就是实例）。这里只共享没有 DOM 的纯展示逻辑
       （useProjectCardBasics：名字底色、阶段文案、进度、截止日期文案），显示层各写各的。 -->
  <div
    v-if="project"
    ref="cardEl"
    class="pr-card hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    :data-canvas-item-id="item.id"
    @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <ProjectCardBody :project="project" />

    <CardActions :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </div>
  <div v-else ref="missingRef" class="pr-missing hover-card-fx" :class="{ connecting, 'connection-target': !!connectionTargetSide }" :style="missingStyle" :data-node-id="item.nodeId" :data-canvas-item-id="item.id" @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter" @mouseleave="onLeave">
    <span class="pr-kind">项目</span>
    <div class="pr-name">{{ item.node.title || '未命名项目' }}</div>
    <!-- projectStore 还在拉取（DefaultLayout.vue 进 app 就发起，画布常是直接落地/刷新页面
         进来的入口，这次请求这时多半还没回来）跟"项目真的被删了"是两回事，但两者都会让
         project 算出来是 null、都会落进这条 v-else 分支——之前不分这两种情况，一律显示
         "已删除，仅保留快照"，缓存刚加载完那一下会先说谎再改口。跟 FileRefCard.vue 同一个
         坑（见其注释），这里只是文字层面的表现，不像文件卡那样有缩略图区带来的跳动。 -->
    <span class="pr-deleted">{{ projectStore.loading ? '加载中…' : '已删除，仅保留快照' }}</span>
    <CardActions :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import { useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'
import { useProjectStore } from '@/stores/projects'
import CardActions from './CardActions.vue'
import CardConnDot from './CardConnDot.vue'
import ProjectCardBody from './ProjectCardBody.vue'

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
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

// CardActions/CardConnDot 用 prop 驱动外观（不是 CSS :hover），两个模板分支（有项目/
// 已删除墓碑）共用同一份悬停状态。
const isHovering = ref(false)
function onEnter() { isHovering.value = true; emit('hover', props.item, true) }
function onLeave() { isHovering.value = false; emit('hover', props.item, false) }

const projectStore = useProjectStore()
const project = computed(() => projectStore.projects.find(p => p.id === props.item.node.refId) || null)
// project 为 null（已删除对象）时走 v-else 的墓碑态，useProjectCardBasics 内部按 project.value
// 直接取字段，传一个占位对象兜底，反正这份 computed 在 project 为 null 时不会被模板用到。
const missingStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})
const cardStyle = computed(() => {
  const { w } = itemSize(props.item)
  return {
    left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}`,
    background: project.value ? `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.value.color}` : undefined,
  }
})

// 项目卡高度随内容自然变化。关系线不再借持久化的 item.h 猜它多高，而是直接消费这张卡
// 上报的实际世界尺寸，避免视图模型和内层卡体两套高度彼此拉扯。
const cardEl = ref<HTMLElement | null>(null)
const missingRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
function emitMeasuredSize() {
  const card = cardEl.value
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = cardEl.value
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => {
  nextTick(observeCard)
})
watch(project, () => nextTick(observeCard))
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())

// 项目和文件贴纸共用同一套物理入口、真实根节点和坐标回调。
const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  getDragEl: () => cardEl.value ?? missingRef.value,
  exclude: target => !!(target as HTMLElement)?.closest?.('.seg-bar-wrap, .card-actions, .conn-dot'),
  onClick: onOpen,
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
function onOpen() {
  emit('open', props.item)
}
</script>

<style scoped>
/* position:absolute（不是 relative）——跟便签/文件/活动贴纸的根节点一致（.note-sticker/
   .entity-sticker/.fr-wrap 都是 absolute），stickerStyle 给的 left/top 是世界坐标系的绝对
   位置。写成 relative 时 left/top 是"从正常文档流位置再偏移"，而 .canvas-world 宽高都是 0，
   块级元素在正常流里会跟其它同样 position:relative 的兄弟节点垂直堆叠——这份「正常流基准
   位置」会随画布上其它项目卡片的数量/高度变化，item.y 的偏移量就是加在一个不固定的基准上，
   越往后建的项目卡片、前面项目卡片越多/越高，累积偏差就越大。
   圆角只用 border-radius，不叠 corner-shape:squircle——文件卡/便签/活动贴纸这几种画布卡片
   都是普通圆角，项目卡跟着统一，不再各转各的曲线。overflow:visible 是因为连接点的判定区
   摆在卡片边缘外侧（见 CardConnDot.vue 的 .conn-dot-left/right），overflow:hidden 会把它们
   裁掉一半；背景渐变本身不需要 overflow:hidden 也会被自己的 border-radius 裁成圆角（元素
   自身背景永远贴合自己的盒子形状，overflow 管的是会溢出盒子的子元素/内容，不影响这点）。
   "正在建立关联"的虚线描边走 global.css 共用的 .connecting 规则，不再各卡自己声明。 */
.pr-card, .pr-missing {
  position: absolute; box-sizing: border-box; user-select: none; cursor: pointer;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  overflow: visible;
}
/* 悬停抬起/阴影加深走全局 .hover-card-fx（已加在模板类名里），但 scoped 样式编译后会带
   [data-v-xxx] 属性选择器，跟上面 .pr-card 静止态 box-shadow 那条一样特异度（类+属性选择
   器），跟全局 .hover-card-fx:hover（类+伪类，同样两级）打平——打平时看两份样式表谁在最终
   产物里排得靠后，不保真。FileCard.vue/EntitySticker.vue 都各自在 scoped 规则里重申一遍
   :hover 的阴影值来稳赢（不依赖顺序），这里补上同一份，否则会出现"看着没有 hover 阴影"
   （静止态那条声明打赢了 hover 态）。 */
.pr-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
/* SegBar.vue 自己的 @click.stop/@mousedown.stop 只挡 click/mousedown 这两种事件冒泡，挡不住
   CSS :active 伪类——按住进度条时鼠标底下的所有祖先（含 .pr-card 自己）都会同时进入 :active
   态，即使点击不会真的冒泡触发拖拽/翻开项目，卡片还是会跟着抖一下"按下"动画。全局
   .hover-card-fx:active:has(...) 那份共用名单没收 .seg-bar-wrap（board 侧的 ProjectCard.vue
   本来就单独有一条这个），这里单独补一份。 */
.pr-card:active:has(.seg-bar-wrap:active) { transform: none; opacity: 1; }

.pr-missing {
  height: 100%; padding: 13px 13px 11px;
  background: rgba(255,255,255,0.5);
  display: flex; flex-direction: column; gap: 8px;
}
.pr-kind { align-self: flex-start; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
.pr-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.pr-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

/* 操作按钮（.card-actions）和连接点（.conn-dot）都挪进了共用组件 CardActions.vue/
   CardConnDot.vue，外观/悬停显形逻辑不再各卡自己抄一份。 */
</style>
