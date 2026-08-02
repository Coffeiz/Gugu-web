<template>
  <article
    class="drawer-project-card hover-card-fx"
    :data-project-id="project.id"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
    @pointerdown.stop="onPointerDown"
    @physics-landing-regrab="onLandingRegrab"
  >
    <ProjectCardBody :project="project" />
  </article>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { startDrawerDrag, startDrawerPointerDrag } from '@/interaction/drag/adapters/drawerDrag'
import type { Project } from '@/types/project'
import ProjectCardBody from './ProjectCardBody.vue'

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
  canvasScale: { type: Number, default: 1 },
  addToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{ (e: 'add'): void }>()

// 拖出抽屉这条路径起拖逻辑抽成独立函数，好让「首次抓起」（onPointerDown）和「画布卡拖回
// 抽屉、飞行中途被重新抓起」（onLandingRegrab，见其注释）复用同一份 startPhysicsDrag 配置，
// 不必维护两份容易长歪的重复逻辑。
function onPointerDown(event: PointerEvent) {
  startDrawerPointerDrag(event, {
    projectId: props.project.id,
    canvasScale: () => props.canvasScale,
    addToCanvas: props.addToCanvas,
    onClick: () => emit('add'),
  })
}
// 画布项目卡拖回抽屉、落地飞行（clone2）中途被重新抓起时的接力入口。usePhysicsDrag.ts 的
// delegateLandingRegrab 机制会把这次手势通过 physics-landing-regrab 事件转手给落点本体
// （ProjectRefCard.vue 那边同款事件转手给画布卡时也是这个模式，见其 onLandingRegrab）——
// 之前这条方向没接这个事件，转手落进没人接的地方，物理模块只能退化用旧的 opts（画布卡那次
// 拖拽的 resolveAbsorbTarget/resolveLandingTarget 等）硬套在抽屉卡身上继续拖，语义完全对不
// 上，表现就是抓起来之后没法再放回画布。接上之后转手改用抽屉卡自己这份 startDrag 配置续接，
// 跟"从抽屉首次拖出"完全同源，行为自然一致。
function onLandingRegrab(event: Event) {
  const handoff = event as CustomEvent<{ event: PointerEvent; initialRect: DOMRect }>
  const card = event.currentTarget as HTMLElement
  startDrawerDrag(handoff.detail.event, card, {
    projectId: props.project.id,
    canvasScale: () => props.canvasScale,
    addToCanvas: props.addToCanvas,
    onClick: () => emit('add'),
  }, { initialRect: handoff.detail.initialRect, isLandingRegrab: true })
  event.preventDefault()
}
</script>

<style scoped>
.drawer-project-card {
  position: relative;
  box-sizing: border-box;
  align-self: center;
  width: 240px;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(80,90,110,.07);
  overflow: hidden;
  cursor: grab;
  user-select: none;
  font-family: var(--font-sans);
  /* 与项目页 .proj-card 保持同一条悬停曲线。这里必须包含 transform；否则本地 transition
     会覆盖全局 hover-card-fx，却让 -2px 抬起没有过渡、看起来像瞬间跳起。 */
  transition: transform .25s cubic-bezier(.34,1.2,.64,1),
              box-shadow .25s ease, background .25s ease-out,
              opacity .25s ease, border-color .25s ease;
}
.drawer-project-card::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255,255,255,.12) 0%, transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9); pointer-events: none;
  transition: opacity .25s ease;
}
.drawer-project-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255,255,255,.55) 0%, rgba(255,255,255,.08) 45%, transparent 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,1); opacity: 0;
  transition: opacity .25s ease; pointer-events: none;
}
.drawer-project-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,.13); }
.drawer-project-card:hover::after { opacity: 1; }
.drawer-project-card:active { cursor: grabbing; }

/* 抽屉素材拖往画布时保留原尺寸的空位，不让列表在拖拽期间重排。这不是纯装饰选择：
   1) 抽屉列表是 <TransitionGroup>，靠 Vue 响应式数据驱动排版——物理模块若直接把源卡
      display:none 再手写兄弟卡 FLIP，Vue 侧数据完全没变，TransitionGroup 不会跟着挪，
      物理模块自己那套 FLIP 又会跟 TransitionGroup 的 move 过渡打架，试过会两边都不对。
   2) 松手落回抽屉时，落地飞行要用 sourceEl 自己的 getBoundingClientRect() 当终点；
      display:none 的元素量出来是全 0，飞行克隆会冲向 (0,0) 的 0 尺寸方框、揭示时
      source 也还停在 display:none 没人给它复原，卡片就"凭空消失"了。保留占位（只降
      透明度，不摘出正常流）让这次量数永远是真实值。 */
/* 虚线颜色跟画布卡片"正在建立关联"用的是同一个（canvas-card-effects.css 的 .connecting
   规则），但粗细跟静止态的 1px 对齐（不用那边的 2px）——占位态和静止态都是同一个
   border-box 元素，边框粗细没理由在这两态之间跳变。 */
.drawer-project-card.phys-drag-source-placeholder {
  background: transparent !important;
  border: 1px dashed rgba(123,127,178,.6);
  box-shadow: none;
  cursor: grabbing;
}
.drawer-project-card.phys-drag-source-placeholder::before,
.drawer-project-card.phys-drag-source-placeholder :deep(.project-card-body) { opacity: 0; }
.drawer-project-card :deep(.project-card-body) { transition: opacity .16s ease; }
</style>
