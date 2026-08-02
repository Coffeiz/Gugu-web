import { createCardMotionController } from './cardMotionController'
import { dragPhysicsTuning, springParamsFromResponse } from '../physicsTuning'

export interface FlyToOptions {
  holder: HTMLElement
  box: { left: number; top: number; width: number; height: number }
  half: { x: number; y: number }
  dropSize: { w: number; h: number }
  shrink: boolean
  fitToTarget?: boolean
  easing: string
  initialVelocity?: { x: number; y: number }
  useSpring?: boolean
  isActive?: () => boolean
  onFinish: () => void
}

/** 单克隆落地动画。业务恢复、session 收尾和 pending cleanup 由调用方拥有。 */
export function animateFlyTo(options: FlyToOptions): () => void {
  const { holder, box, half, dropSize } = options
  let finished = false
  let onEnd: (event: TransitionEvent) => void = () => undefined
  const finish = () => {
    if (finished) return
    finished = true
    holder.removeEventListener('transitionend', onEnd)
    if (options.isActive?.() ?? true) options.onFinish()
    else holder.remove()
  }
  // centerX/centerY 原来声明在下面固定 CSS transition 分支的开头（第 69/70 行附近），
  // 但这个弹簧分支在它们声明之前就引用了——const 声明会被提升进临时死区，运行时会直接
  // 抛 ReferenceError（不是"物理效果不对"，是这条分支一进来就崩）。提到函数最前面，
  // 两个分支共用同一份计算。
  const centerX = box.left + box.width / 2
  const centerY = box.top + box.height / 2
  if (options.useSpring && !options.shrink && options.fitToTarget !== false) {
    const current = holder.getBoundingClientRect()
    const targetX = centerX - half.x
    const targetY = centerY - half.y
    const landingParams = springParamsFromResponse(dragPhysicsTuning.landing)
    const controller = createCardMotionController({
      mode: 'settle',
      onFrame: frame => {
        holder.style.transition = 'none'
        holder.style.transform = `translate3d(${frame.x.toFixed(2)}px, ${frame.y.toFixed(2)}px, 0) scale(${frame.scaleX.toFixed(4)}, ${frame.scaleY.toFixed(4)})`
      },
      onArrived: finish,
    })
    // 同上——CardMotionControllerOptions 不再接受构造时的 profile 字段。
    controller.setProfile({ position: landingParams, scale: landingParams })
    controller.seed({
      x: current.left,
      y: current.top,
      vx: options.initialVelocity?.x ?? 0,
      vy: options.initialVelocity?.y ?? 0,
      scaleX: 1,
      scaleY: 1,
      scaleVX: 0,
      scaleVY: 0,
    })
    controller.setTarget({
      x: targetX,
      y: targetY,
      scaleX: box.width / Math.max(1, dropSize.w),
      scaleY: box.height / Math.max(1, dropSize.h),
    })
    controller.start()
    return () => {
      controller.stop()
      finish()
    }
  }
  holder.style.transition = `transform 0.55s ${options.easing}, opacity 0.4s ease`
  if (options.shrink) {
    holder.style.opacity = '0'
    holder.style.transform =
      `translate3d(${(centerX - half.x).toFixed(2)}px, ${(centerY - half.y).toFixed(2)}px, 0) scale(0.32)`
  } else if (options.fitToTarget === false) {
    holder.style.transform = `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) scale(1)`
    holder.style.opacity = '0'
  } else {
    const scaleX = (box.width / dropSize.w).toFixed(4)
    const scaleY = (box.height / dropSize.h).toFixed(4)
    holder.style.transform =
      `translate3d(${(centerX - half.x).toFixed(2)}px, ${(centerY - half.y).toFixed(2)}px, 0) scale(${scaleX}, ${scaleY})`
  }
  onEnd = finish
  holder.addEventListener('transitionend', onEnd)
  const timer = setTimeout(finish, 680)
  return () => {
    clearTimeout(timer)
    finish()
  }
}
