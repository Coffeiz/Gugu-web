import type { DragSession } from '../core/DragSession'
import {
  cloneForDrag,
  createLandingClone,
  type DragCloneOptions,
  type LandingCloneOptions,
} from './clone'
import { holdHoverUntilReveal, revealWithoutStaleHover } from './reveal'

/**
 * 卡片视觉资源的唯一登记点。
 * 几何事务不创建或清理 clone；session 取消时由这里回收仍连接在 DOM 中的代理。
 */
export interface CardVisualController {
  cloneForDrag(source: HTMLElement, options?: DragCloneOptions): HTMLElement
  createLandingClone(source: HTMLElement, options: LandingCloneOptions): HTMLElement
  holdHoverUntilReveal(element: HTMLElement): void
  reveal(element: HTMLElement, pointerMode: boolean, onSettled?: () => void, keepControls?: boolean, isActive?: () => boolean): void
  cleanup(): void
}

export function createCardVisualController(session: DragSession): CardVisualController {
  const owned = new Set<HTMLElement>()
  let disposed = false

  const disposeElement = (element: HTMLElement) => {
    owned.delete(element)
    if (element.isConnected) element.remove()
  }

  const track = (element: HTMLElement) => {
    if (disposed) {
      element.remove()
      return element
    }
    owned.add(element)
    return element
  }

  session.addCleanup(() => {
    disposed = true
    for (const element of owned) disposeElement(element)
    owned.clear()
  })

  return {
    cloneForDrag(source, options) {
      return track(cloneForDrag(source, options))
    },
    createLandingClone(source, options) {
      return track(createLandingClone(source, options))
    },
    holdHoverUntilReveal(element) {
      holdHoverUntilReveal(element)
    },
    reveal(element, pointerMode, onSettled, keepControls, isActive) {
      revealWithoutStaleHover(element, pointerMode, onSettled, keepControls, isActive)
    },
    cleanup() {
      disposed = true
      for (const element of owned) disposeElement(element)
      owned.clear()
    },
  }
}
