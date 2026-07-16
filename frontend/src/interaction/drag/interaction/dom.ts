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

/**
 * 量出「祖先链上所有正在播的过渡/动画都播完之后」目标元素的最终布局盒。
 *
 * 抽屉这类容器的高度用 CSS transition 展开时，inline style 里的目标高度一开始就已写好，
 * 只是渲染值还在过渡中间——逐帧读布局只能拿到中间态。这里用 Web Animations API 把目标
 * 到 body 之间每个祖先身上正在运行的动画临时 seek 到终点、量一次最终布局、再逐个 seek
 * 回原进度恢复播放。整个过程在同一个 JS 任务里完成，中间没有绘制，肉眼不可见；对没有
 * 动画在跑的场景，行为等同于直接调 layoutBoxInScroller。
 */
export function layoutBoxAtTransitionsEnd(scroller: HTMLElement, target: HTMLElement) {
  const seeked: Array<{ animation: Animation; time: CSSNumberish | null }> = []
  let current: HTMLElement | null = target
  while (current && current !== document.body) {
    if (typeof current.getAnimations === 'function') {
      for (const animation of current.getAnimations()) {
        const timing = animation.effect?.getComputedTiming()
        // endTime 为无穷（无限循环动画）或拿不到时无法 seek 到"终点"，跳过
        const endTime = timing?.endTime
        if (typeof endTime !== 'number' || !Number.isFinite(endTime)) continue
        seeked.push({ animation, time: animation.currentTime })
        animation.pause()
        animation.currentTime = endTime
      }
    }
    current = current.parentElement
  }
  const box = layoutBoxInScroller(scroller, target)
  for (const { animation, time } of seeked) {
    animation.currentTime = time
    animation.play()
  }
  return box
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
