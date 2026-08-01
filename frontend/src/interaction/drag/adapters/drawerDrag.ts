import { coastOffset } from './canvasDrag'
import { startPhysicsDrag, startThresholdDrag } from '../../../composables/usePhysicsDrag'

const DRAWER_SCALE_MS = 160

export interface DrawerDragOptions {
  projectId: number
  // 活的取值函数，不能传静态快照——抓着卡片不放的时候用户还可能滚轮继续缩放画布，
  // 静态数字在抓起那一刻就冻住了，之后画布怎么缩放克隆都不会跟着变
  // （2026-07-17 复现：抽屉拖出的项目卡克隆无法跟随摄像机放大缩小）。
  canvasScale: () => number
  addToCanvas: (projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>
  onClick: () => void
}

export interface DrawerDragStartOptions {
  initialRect?: { left: number; top: number; width: number; height: number }
  isLandingRegrab?: boolean
}

/** 项目抽屉 adapter：负责抽屉与画布之间的业务接力，动画细节仍由拖拽运行时持有。 */
export function startDrawerDrag(
  event: PointerEvent,
  card: HTMLElement,
  options: DrawerDragOptions,
  startOptions: DrawerDragStartOptions = {},
): void {
  let landingTarget: HTMLElement | null = null
  let returnTarget: HTMLElement | null = null
  let scaleStartedAt: number | null = null
  const isLandingRegrab = startOptions.isLandingRegrab === true
  const canvasContentScale = () => {
    if (scaleStartedAt == null) return 1
    const progress = Math.min(1, (performance.now() - scaleStartedAt) / DRAWER_SCALE_MS)
    const eased = 1 - (1 - progress) ** 3
    return 1 + (options.canvasScale() - 1) * eased
  }

  startPhysicsDrag(event, card, {
    pointer: true,
    skipAbsorb: false,
    centerGrab: true,
    contentScale: canvasContentScale,
    lift: 1.03,
    dragZIndex: 31,
    cloneClass: 'pr-card',
    keepSourcePlaceholder: true,
    removeSourceOnExternalDrop: true,
    delegateLandingRegrab: true,
    absorbShrink: false,
    resolveAbsorbTarget: () => returnTarget,
    onDrop: (center, velocity, size, context) => {
      const pointer = context?.pointer ?? center
      const drawer = document.querySelector<HTMLElement>('[data-project-drawer-dropzone]')
      const drawerRect = drawer?.getBoundingClientRect()
      if (drawer && drawerRect && pointer.x >= drawerRect.left && pointer.x <= drawerRect.right && pointer.y >= drawerRect.top && pointer.y <= drawerRect.bottom) {
        returnTarget = card
        landingTarget = null
        return
      }
      const pointerVelocity = context?.pointerVelocity
      const launchVelocity = pointerVelocity && Math.hypot(pointerVelocity.x, pointerVelocity.y) > 80
        ? { ...pointerVelocity, turn: velocity.turn }
        : velocity
      const coast = coastOffset(launchVelocity)
      returnTarget = null
      options.addToCanvas(options.projectId, { x: center.x + coast.x, y: center.y + coast.y }, size)
        .then(target => { landingTarget = target })
        .catch(() => { landingTarget = null })
    },
    resolveLandingTarget: () => landingTarget,
    landingTargetWaitMs: 1400,
    initialRect: startOptions.initialRect,
    initialHover: isLandingRegrab,
    isLandingRegrab,
  })
  requestAnimationFrame(() => { scaleStartedAt = performance.now() })
}

export function startDrawerPointerDrag(event: PointerEvent, options: DrawerDragOptions): (() => void) | undefined {
  return startThresholdDrag(event, {
    exclude: target => !!(target as HTMLElement | null)?.closest('.seg-bar-wrap, button, input, textarea, select, a'),
    onDragStart: (moveEvent, card) => startDrawerDrag(moveEvent, card, options),
    onClick: options.onClick,
  })
}
