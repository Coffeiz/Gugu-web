export interface DragHandoffDetail {
  event: PointerEvent
  initialRect: DOMRect
}

/**
 * 将落地中的视觉拖拽交给真实目标卡片。
 * handoff 只负责事件协议，不决定目标业务、物理参数或 clone 生命周期。
 */
export function dispatchDragHandoff(target: HTMLElement, event: PointerEvent, initialRect: DOMRect): boolean {
  const handoff = new CustomEvent<DragHandoffDetail>('physics-landing-regrab', {
    bubbles: false,
    cancelable: true,
    detail: { event, initialRect },
  })
  target.dispatchEvent(handoff)
  return handoff.defaultPrevented
}

export interface LandingHandoffOptions {
  enabled: boolean
  holder: HTMLElement
  clone: HTMLElement
  target: HTMLElement
  isActive: () => boolean
  startThreshold: (event: PointerEvent, options: {
    getCard: () => HTMLElement
    onDragStart: (event: PointerEvent) => void
  }) => (() => void) | undefined
  onRegrab: (event: PointerEvent, visualRect: DOMRect) => void
}

/** 管理落地 clone 上的再次抓取监听，不决定接手后的业务拖拽配置。 */
export function installLandingHandoff(options: LandingHandoffOptions): () => void {
  if (!options.enabled) return () => undefined
  let cancelThreshold: (() => void) | null = null
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || cancelThreshold) return
    event.preventDefault()
    event.stopPropagation()
    cancelThreshold = options.startThreshold(event, {
      getCard: () => options.target,
      onDragStart: (moveEvent) => {
        cancelThreshold = null
        if (!options.isActive() || !options.holder.isConnected) return
        const cloneRect = options.clone.getBoundingClientRect()
        const holderRect = options.holder.getBoundingClientRect()
        options.onRegrab(moveEvent, cloneRect.width > 0 && cloneRect.height > 0 ? cloneRect : holderRect)
      },
    }) ?? null
  }
  options.holder.style.pointerEvents = 'auto'
  options.holder.addEventListener('pointerdown', onPointerDown)
  return () => {
    cancelThreshold?.()
    cancelThreshold = null
    options.holder.removeEventListener('pointerdown', onPointerDown)
    options.holder.style.pointerEvents = 'none'
  }
}
