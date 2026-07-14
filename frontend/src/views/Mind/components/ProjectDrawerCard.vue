<template>
  <article
    class="drawer-project-card hover-card-fx"
    :data-project-id="project.id"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
    @pointerdown.stop="onPointerDown"
  >
    <ProjectCardBody :project="project" />
  </article>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { coastOffset } from '@/composables/useCardDrag'
import { startPhysicsDrag, startThresholdDrag } from '@/composables/usePhysicsDrag'
import type { Project } from '@/types/project'
import ProjectCardBody from './ProjectCardBody.vue'

const DRAWER_SCALE_MS = 160

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
  canvasScale: { type: Number, default: 1 },
  addToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{ (e: 'add'): void }>()

function onPointerDown(event: PointerEvent) {
  startThresholdDrag(event, {
    exclude: target => !!(target as HTMLElement | null)?.closest('.seg-bar-wrap, button, input, textarea, select, a'),
    onDragStart: (moveEvent, card) => {
      let landingTarget: HTMLElement | null = null
      let returnTarget: HTMLElement | null = null
      let scaleStartedAt: number | null = null
      const canvasContentScale = () => {
        if (scaleStartedAt == null) return 1
        const progress = Math.min(1, (performance.now() - scaleStartedAt) / DRAWER_SCALE_MS)
        // 与抓起抬高同一段缓出：第一克隆从抽屉实体尺寸自然收进当前画布比例，之后才
        // 直接跟随实时相机缩放。用 transform 缩放，不触发文字重排。
        const eased = 1 - (1 - progress) ** 3
        return 1 + (props.canvasScale - 1) * eased
      }
      startPhysicsDrag(moveEvent, card, {
        pointer: true,
        skipAbsorb: false,
        centerGrab: true,
        contentScale: canvasContentScale,
        lift: 1.03,
        dragZIndex: 10,
        cloneClass: 'pr-card',
        keepSourcePlaceholder: true,
        removeSourceOnExternalDrop: true,
        delegateLandingRegrab: true,
        // 放回抽屉时也以整张卡为落点交接：和画布内卡片归位相同，不能缩成一个点再露出源卡。
        absorbShrink: false,
        // 抽屉仍是这次外部拖拽的有效回收目标。命中时不创建画布节点，让物理模块走
        // 原有“吸入源占位并恢复”的归位路径。
        resolveAbsorbTarget: () => returnTarget,
        onDrop: (center, velocity, size, context) => {
          const pointer = context?.pointer ?? center
          const drawer = document.querySelector<HTMLElement>('[data-project-drawer-dropzone]')
          const drawerRect = drawer?.getBoundingClientRect()
          if (drawer && drawerRect && pointer.x >= drawerRect.left && pointer.x <= drawerRect.right && pointer.y >= drawerRect.top && pointer.y <= drawerRect.bottom) {
            returnTarget = card
            return
          }
          // 抽屉来源的克隆有跟手弹簧，快速松手时它自己的速度可能已被阻尼压低；优先取
          // 连续采样的指针释放速度，才能和画布内卡片一样保留明确的抛出方向与惯性。
          const pointerVelocity = context?.pointerVelocity
          const launchVelocity = pointerVelocity && Math.hypot(pointerVelocity.x, pointerVelocity.y) > 80
            ? { ...pointerVelocity, turn: velocity.turn }
            : velocity
          const coast = coastOffset(launchVelocity)
          props.addToCanvas(props.project.id, { x: center.x + coast.x, y: center.y + coast.y }, size)
            .then(target => { landingTarget = target })
            .catch(() => { landingTarget = null })
        },
        resolveLandingTarget: () => landingTarget,
        landingTargetWaitMs: 1400,
      })
      // 先提交抽屉本体大小这一帧，再让下一轮物理积分开始向画布比例收拢；不能在同一帧
      // 直接传 canvasScale，否则浏览器只会看到一张已经缩小的克隆。
      requestAnimationFrame(() => { scaleStartedAt = performance.now() })
    },
    onClick: () => emit('add'),
  })
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
