/**
 * 读取卡片所在最近层叠上下文的 z-index，供落地阶段使用。
 * 层级策略只依赖 DOM 上下文，不持有拖拽 session 或业务状态。
 */
export function resolveLandingZIndex(el: HTMLElement | null): number {
  let node = el
  while (node && node !== document.body) {
    const style = getComputedStyle(node)
    if (style.position !== 'static' && style.zIndex !== 'auto') {
      const zIndex = parseInt(style.zIndex, 10)
      if (!Number.isNaN(zIndex)) return zIndex + 10
    }
    node = node.parentElement
  }
  return 2
}
