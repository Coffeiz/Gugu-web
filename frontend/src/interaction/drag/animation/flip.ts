export interface FlipOptions {
  duration?: number
  easing: string
  onBeforePlay?: () => void
  isActive?: () => boolean
}

/** FLIP 只负责位置动画，落点业务和 session 生命周期由调用方提供。 */
export function invertPlay(
  elements: HTMLElement[],
  fromRects: DOMRect[],
  toRects: DOMRect[],
  options: FlipOptions,
): void {
  options.onBeforePlay?.()
  elements.forEach((element, index) => {
    const dx = fromRects[index].left - toRects[index].left
    const dy = fromRects[index].top - toRects[index].top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    element.style.transition = 'none'
    element.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
  })
  requestAnimationFrame(() => {
    if (options.isActive && !options.isActive()) return
    for (const element of elements) {
      if (!element.style.transform) continue
      element.style.transition = `transform ${options.duration ?? 340}ms ${options.easing}`
      element.style.transform = ''
      const clear = () => {
        element.style.transition = ''
        element.removeEventListener('transitionend', clear)
      }
      element.addEventListener('transitionend', clear)
      setTimeout(clear, (options.duration ?? 340) + 80)
    }
  })
}
