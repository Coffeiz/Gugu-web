/** 找到拖拽落点所在的可纵向滚动祖先。 */
export function findScrollParent(node: Element | null): HTMLElement | null {
  const known = node?.closest?.('.col-body, .files-main') as HTMLElement | null
  if (known && known.scrollHeight > known.clientHeight + 1) return known
  let parent = node?.parentElement ?? null
  while (parent) {
    const overflow = getComputedStyle(parent).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight + 1) {
      return parent
    }
    parent = parent.parentElement
  }
  return null
}

/**
 * 返回元素在滚动容器可视坐标系里的最终布局盒。
 *
 * getBoundingClientRect() 会把 Vue TransitionGroup 为 FLIP 写入的 transform 一并算进去；
 * 卡片刚插入抽屉时拿它当飞行终点，会读到“让位途中”的旧位置。offsetTop/offsetLeft 不受
 * transform 影响，沿各自的 offsetParent 链累加后相减，可得到同一布局坐标系下的最终位置。
 */
export function layoutBoxInScroller(scroller: HTMLElement, target: HTMLElement) {
  const layoutOffset = (element: HTMLElement) => {
    let left = 0
    let top = 0
    let current: HTMLElement | null = element
    while (current) {
      left += current.offsetLeft
      top += current.offsetTop
      current = current.offsetParent as HTMLElement | null
    }
    return { left, top }
  }

  const targetOffset = layoutOffset(target)
  const scrollerOffset = layoutOffset(scroller)
  const scrollerRect = scroller.getBoundingClientRect()
  return {
    left: scrollerRect.left + scroller.clientLeft + targetOffset.left - scrollerOffset.left - scroller.scrollLeft,
    top: scrollerRect.top + scroller.clientTop + targetOffset.top - scrollerOffset.top - scroller.scrollTop,
    width: target.offsetWidth,
    height: target.offsetHeight,
  }
}

/** 使用固定时长的 ease-out 补间滚动，避免原生 smooth 在 drop 场景退化成瞬移。 */
export function animateScroll(
  element: HTMLElement,
  distance: number,
  duration = 300,
  isActive: () => boolean = () => true,
): void {
  const from = element.scrollTop
  const ease = (t: number) => 1 - Math.pow(1 - t, 3)
  let startedAt: number | null = null
  const tick = (now: number) => {
    if (!isActive()) return
    if (startedAt === null) startedAt = now
    const progress = Math.min(1, (now - startedAt) / duration)
    element.scrollTop = from + distance * ease(progress)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
