export interface ThresholdDragOpts {
  threshold?: number
  exclude?: (target: EventTarget | null) => boolean
  getCard?: (event: PointerEvent) => HTMLElement | null
  onBeforeDragStart?: () => void
  onDragStart: (event: PointerEvent, card: HTMLElement) => void
  onClick?: () => void
}

/** 点击与拖拽的阈值判定，不持有物理或视觉状态。 */
export function startThresholdDrag(event: PointerEvent, opts: ThresholdDragOpts): (() => void) | undefined {
  if (event.pointerType === 'mouse' && event.button !== 0) return undefined
  if (opts.exclude?.(event.target)) return undefined
  const card = opts.getCard ? opts.getCard(event) : (event.currentTarget as HTMLElement)
  if (!card) return undefined
  const sx = event.clientX, sy = event.clientY
  const threshold = opts.threshold ?? 5
  let started = false
  const onMove = (ev: PointerEvent) => {
    if (started || Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return
    started = true
    teardown()
    opts.onBeforeDragStart?.()
    opts.onDragStart(ev, card)
  }
  const onUp = () => { teardown(); if (!started) opts.onClick?.() }
  const teardown = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  return teardown
}
