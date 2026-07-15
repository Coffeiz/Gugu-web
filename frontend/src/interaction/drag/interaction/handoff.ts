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
