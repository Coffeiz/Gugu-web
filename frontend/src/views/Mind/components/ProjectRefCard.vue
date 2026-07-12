<template>
  <div class="pr-wrap" :class="{ connecting }" :style="stickerStyle" :data-node-id="item.nodeId" @pointerdown.stop>
    <template v-if="project">
      <!-- 直接嵌真正的 ProjectCard.vue（星级/阶段待办弹层/推进按钮都是它自己原生的交互），
           不是照抄样式的仿制品。它自己的按住阈值起拖那套物理原样保留，只是把「松手后干什么」
           换成画布定位落库（见 onCanvasDrop），不用另起一个抓手当拖拽入口——整张卡都能拖，
           星级/阶段/进度条这些内部控件仍归它自己排除、点击不会被当成拖拽。移除按钮/连接点都
           走它开放的插槽（是 .proj-card 的子节点，会跟着它的拖拽克隆一起飞，不会掉队原地——
           之前连接点摆在插槽外面，卡片飞走了圆点却留在原地不跟）。 -->
      <ProjectCard ref="cardRef" :project="project" :on-drop-override="onCanvasDrop" :drag-opts="CANVAS_DRAG_OPTS" @click="onOpen">
        <div class="pr-actions">
          <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
        </div>
        <button class="conn-dot conn-dot-left" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
        <button class="conn-dot conn-dot-right" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
      </ProjectCard>
    </template>
    <div v-else class="pr-missing" @pointerdown.stop="onPointerDown">
      <span class="pr-kind">项目</span>
      <div class="pr-name">{{ item.node.title || '未命名项目' }}</div>
      <span class="pr-deleted">已删除，仅保留快照</span>
      <div class="pr-actions">
        <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
      </div>
      <button class="conn-dot conn-dot-left" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
      <button class="conn-dot conn-dot-right" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, type PropType } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import ProjectCard from '@/views/Projects/components/ProjectCard.vue'
import { animateLanding, coastOffset, useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'
import { useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
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
  (e: 'connectDragStart', event: PointerEvent): void
}>()

const store = useMindStore()
const projectStore = useProjectStore()
const project = computed(() => projectStore.projects.find(p => p.id === props.item.node.refId) || null)
const stickerStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})

// ProjectCard.vue 自身内容行数不固定（客户名有无、阶段徽标、完成态换掉底部那一行），真实
// 渲染高度跟 defaultItemSize 里那份"典型情况"估算值天然对不上——连线锚点（RelationLayer.vue
// 拿 item.h 算竖直中点）和拖拽落点（下面 onCanvasDrop 拿它反推卡片中心）用的都是这份估算值，
// 跟卡片实际显示的位置比总会有落差（用户反馈"连线不在正中间""落点偏高"，本质都是这个估算
// 值不准）。便签/文件/活动贴纸内容结构固定、默认值贴得住，项目卡片这里干脆直接量一次真实
// 渲染高度写回 item.h——量准了之后 itemSize 全站统一读的就是这个真实值，不用再猜。只在挂载
// 和项目内容变化时测（不是每帧持续观察）：拖拽中源卡是隐藏的，量到的会是 0，且卡片高度本来
// 就不会在拖拽过程中变化，没必要用 ResizeObserver 常驻盯着。
const cardRef = ref<InstanceType<typeof ProjectCard> | null>(null)
function syncMeasuredHeight() {
  const el = cardRef.value?.$el as HTMLElement | undefined
  if (!el) return
  const scale = props.scale || 1
  const renderedH = el.getBoundingClientRect().height
  if (renderedH < 10) return   // 隐藏/未渲染完成时量到的是 0，不采信
  const worldH = Math.round(renderedH / scale)
  const current = itemSize(props.item).h
  if (Math.abs(worldH - current) > 1) {
    store.updateCanvasItem(props.item.id, { h: worldH }).catch(() => {})
  }
}
watch(project, () => { void nextTick(() => syncMeasuredHeight()) }, { immediate: true })

// ProjectCard 自己的 onPointerDown 全权接管「按住阈值起拖」，这里不重新起一套竞争的拖拽——
// 只借它的 onDropOverride 把松手时的屏幕坐标换算成世界坐标，卡片中心落在鼠标下（不延续
// 抓取时的偏移量），跟便签/文件/活动贴纸的 useCardDrag.onDropAt 是同一套落点算法。落库坐标
// 必须同步给出（物理模块紧接着要用贴纸最新位置算克隆体落地飞行目标），但落地飞行本身还要
// 0.55s 才到位——连线不能瞬间跳到终点，跟便签/文件/活动贴纸一样用 animateLanding 单独补一段
// 跟克隆体同时长/同缓动的插值喂给 landing（不是 dragging：item.x/y 这里已经同步落到终点了，
// 再用 dragging 写回去会先闪一下终点、再跳回起点重播这段动画，见 useCardDrag.ts 的 onLanding
// 注释和 MindCanvas.vue 的 landingPositions）；插值播完用 landingDone 通知清掉覆盖位置。
function onCanvasDrop({ x, y }: { x: number; y: number }, velocity: { x: number; y: number; turn: number }) {
  const coast = coastOffset(velocity)
  const dropWorld = props.screenToWorld(x, y)
  const landWorld = props.screenToWorld(x + coast.x, y + coast.y)
  const { w, h } = itemSize(props.item)
  emit('moved', props.item, landWorld.x - w / 2, landWorld.y - h / 2)
  if (coast.x || coast.y) {
    animateLanding(
      dropWorld, landWorld,
      (wx, wy) => emit('landing', props.item, wx - w / 2, wy - h / 2),
      () => emit('landingDone', props.item),
    )
  }
}

// 跟便签/文件/活动贴纸用的 useCardDrag.ts 同一套手感：tilt:0 关掉 3D 后仰，lift:1.03 轻抬起；
// sway 不传，走物理模块默认值。另外补上 onFollow——ProjectCard 自己的物理拖拽此前没有把拖拽
// 中的实时位置吐出来，关系线只能等松手那一刻才跳过去（其它三种贴纸都有 onDragMove 实时回调，
// 唯独嵌套 ProjectCard 这条路径没接，连线看着不跟手）。这里借 dragOpts 透传的 onFollow（会被
// ProjectCard.vue 的 startPhysicsDrag(...， { ...props.dragOpts }) 原样吃进去）补上同款实时跟随——
// 用 onFollow（克隆体弹簧积分出来的真实视觉中心）而不是 onDragOver（瞬时指针位置），否则连线
// 会比带阻力的克隆体先到、跑到卡片上方，也没有该有的拖拽阻力感。
const CANVAS_DRAG_OPTS = computed(() => ({
  tilt: 0,
  lift: 1.03,
  // 跟便签/文件/活动贴纸（useCardDrag.ts）同一个理由：无限画布上抓哪张卡都该是卡片中心
  // 跟手，不用看板卡"从顶部附近拈起"那套 grabY 手感——ProjectCard.vue 自己走看板拖拽时
  // 默认不传这个（沿用它原生手感），只有画布这条路径要。
  centerGrab: true,
  contentScale: () => props.scale,
  // 同 useCardDrag.ts 的 dragZIndex：ProjectCard.vue 自己的 startPhysicsDrag 调用没设默认
  // zIndex，不传这个会掉回全站默认的 99999，飞过侧栏时盖住导航，见那边的详细注释。
  dragZIndex: 10,
  onFollow: ({ x, y }: { x: number; y: number }) => {
    const world = props.screenToWorld(x, y)
    const { w, h } = itemSize(props.item)
    emit('dragging', props.item, world.x - w / 2, world.y - h / 2)
  },
}))

// 缺失态（项目已删除）没有嵌套的 ProjectCard 可以代管拖拽，走跟便签/文件贴纸一样的通用拖拽。
const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  onClick: () => {},
  onDragMove: (worldX, worldY) => {
    const { w, h } = itemSize(props.item)
    emit('dragging', props.item, worldX - w / 2, worldY - h / 2)
  },
  onLanding: (worldX, worldY) => {
    const { w, h } = itemSize(props.item)
    emit('landing', props.item, worldX - w / 2, worldY - h / 2)
  },
  onLandingDone: () => emit('landingDone', props.item),
  onDropAt: (worldX, worldY) => {
    const { w, h } = itemSize(props.item)
    emit('moved', props.item, worldX - w / 2, worldY - h / 2)
  },
})
function onOpen() {
  emit('open', props.item)
}
</script>

<style scoped>
.pr-wrap { position: relative; box-sizing: border-box; user-select: none; }
.pr-wrap.connecting :deep(.proj-card) { outline: 2px dashed rgba(123,127,178,0.6); outline-offset: 2px; }
/* .proj-card 全局有 overflow:hidden（裁掉溢出圆角的杂边）。连接点/移除按钮走它的插槽后
   变成它的子节点才能跟着拖拽克隆一起飞（见上面模板注释），但圆点摆在卡片边缘外侧
   （见下方 .conn-dot 的 left:-6px/right:-6px），会被这份 overflow:hidden 整个裁掉一半——
   看着像"连接点被裁在卡片容器里"。卡片内部会溢出圆角的内容早已各自有自己的
   border-radius/overflow（::before/::after 用 inset:0+border-radius:inherit 自成一体，
   缩略图区也有独立的 overflow:hidden），改成 visible 不会露出裁切前要挡住的东西。
   height:100% 特意不写：曾经写过，但 .pr-wrap 只有 min-height（没有 height），百分比高度在
   没有definite高度的父级上解不出来，这条规则实际从没生效过，.proj-card 一直是按自然内容
   高度渲染——写了反而让人误以为卡片真的被撑到跟 min-height 一样高，跟拖拽落点/连线锚点用的
   假设高度（见 useMindCanvas.ts 的 defaultItemSize）对不上，参见 project 那一档的注释。 */
.pr-wrap :deep(.proj-card) { overflow: visible; }

.pr-missing {
  position: relative; height: 100%; box-sizing: border-box; padding: 13px 13px 11px;
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md); corner-shape: squircle;
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  display: flex; flex-direction: column; gap: 8px; cursor: grab; touch-action: none;
}
.pr-kind { align-self: flex-start; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
.pr-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.pr-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

.pr-actions { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.pr-wrap:hover .pr-actions { opacity: 1; }
.pr-actions button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: 5px; background: rgba(255,255,255,0.7); color: var(--text-secondary); cursor: pointer; }
.pr-actions button:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }

.conn-dot {
  position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px;
  border: 2px solid #fff; border-radius: 50%; padding: 0;
  background: var(--color-primary); box-shadow: 0 1px 4px rgba(80,90,110,.35);
  opacity: 0; transition: opacity 0.15s, transform 0.15s; cursor: crosshair; z-index: 6;
}
.pr-wrap:hover .conn-dot { opacity: 1; }
.conn-dot:hover { transform: scale(1.3); }
.conn-dot-left { left: -6px; }
.conn-dot-right { right: -6px; }
</style>
