export interface FlyToOptions {
  holder: HTMLElement
  box: { left: number; top: number; width: number; height: number }
  half: { x: number; y: number }
  dropSize: { w: number; h: number }
  shrink: boolean
  fitToTarget?: boolean
  easing: string
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
  const centerX = box.left + box.width / 2
  const centerY = box.top + box.height / 2
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
