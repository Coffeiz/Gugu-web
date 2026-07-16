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
