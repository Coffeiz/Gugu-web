import type { FlipOptions } from './flip'

export type FlipKey = string | number
export type FlipResult = 'finished' | 'cancelled' | 'stale' | 'skipped'

export interface FlipItem {
  key: FlipKey
  element: HTMLElement
}

export interface FlipTransaction {
  capture(items: FlipItem[], rects?: DOMRect[]): void
  measure(items?: FlipItem[], rects?: DOMRect[]): void
  play(): Promise<FlipResult>
  cancel(): void
}

interface InlineSnapshot {
  transform: string
  transition: string
  writtenTransform: string
  writtenTransition: string
}

const owners = new WeakMap<HTMLElement, symbol>()

/** 有明确样式所有权和可取消结果的单次 FLIP 位移事务。 */
export function createFlipTransaction(options: FlipOptions): FlipTransaction {
  const token = Symbol('flip-transaction')
  let before = new Map<FlipKey, DOMRect>()
  let after = new Map<FlipKey, DOMRect>()
  let items = new Map<FlipKey, HTMLElement>()
  let snapshots = new Map<HTMLElement, InlineSnapshot>()
  let cancelled = false
  let settled = false
  let resolvePlay: ((result: FlipResult) => void) | null = null
  let finishTimer: number | null = null
  let pending = new Set<HTMLElement>()

  const active = () => !cancelled && !settled && (options.isActive?.() ?? true)
  const read = (list: FlipItem[], rects?: DOMRect[]) => {
    const result = new Map<FlipKey, DOMRect>()
    list.forEach((item, index) => result.set(item.key, rects?.[index] ?? item.element.getBoundingClientRect()))
    return result
  }
  const restore = (element: HTMLElement) => {
    if (owners.get(element) !== token) return
    const snapshot = snapshots.get(element)
    if (!snapshot) return
    if (element.style.transform === snapshot.writtenTransform && element.style.transition === snapshot.writtenTransition) {
      element.style.transform = snapshot.transform
      element.style.transition = snapshot.transition
    }
    owners.delete(element)
    snapshots.delete(element)
  }
  const settle = (result: FlipResult) => {
    if (settled) return
    settled = true
    if (finishTimer !== null) window.clearTimeout(finishTimer)
    pending.forEach(restore)
    pending.clear()
    resolvePlay?.(result)
    resolvePlay = null
  }

  return {
    capture(list, rects) {
      if (!active()) return
      items = new Map(list.map(item => [item.key, item.element]))
      before = read(list, rects)
    },
    measure(list = Array.from(items, ([key, element]) => ({ key, element })), rects) {
      if (!active()) return
      after = read(list, rects)
      items = new Map(list.map(item => [item.key, item.element]))
    },
    play() {
      if (!active()) return Promise.resolve('stale')
      const moving: Array<{ element: HTMLElement; dx: number; dy: number }> = []
      for (const [key, element] of items) {
        const from = before.get(key), to = after.get(key)
        if (!from || !to || !element.isConnected || from.width === 0 || from.height === 0 || to.width === 0 || to.height === 0) continue
        const dx = from.left - to.left, dy = from.top - to.top
        if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) moving.push({ element, dx, dy })
      }
      if (!moving.length) return Promise.resolve('skipped')
      options.onBeforePlay?.()
      if (!active()) return Promise.resolve('stale')
      moving.forEach(({ element, dx, dy }) => {
        owners.set(element, token)
        snapshots.set(element, {
          transform: element.style.transform,
          transition: element.style.transition,
          writtenTransform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`,
          writtenTransition: 'none',
        })
        pending.add(element)
        element.style.setProperty('transition', 'none', 'important')
        element.style.transform = snapshots.get(element)!.writtenTransform
      })
      return new Promise<FlipResult>(resolve => {
        resolvePlay = resolve
        requestAnimationFrame(() => {
          if (!active()) return settle(options.isActive?.() === false ? 'stale' : 'cancelled')
          const transition = `transform ${options.duration ?? 340}ms ${options.easing}`
          pending.forEach(element => {
            if (owners.get(element) !== token || !element.isConnected) return
            element.style.setProperty('transition', transition, 'important')
            element.style.transform = ''
            const snapshot = snapshots.get(element)
            if (snapshot) {
              snapshot.writtenTransform = ''
              snapshot.writtenTransition = transition
            }
            element.addEventListener('transitionend', event => {
              if (event.propertyName === 'transform') {
                pending.delete(element)
                restore(element)
                if (!pending.size) settle('finished')
              }
            }, { once: true })
          })
          finishTimer = window.setTimeout(() => settle(active() ? 'finished' : 'stale'), (options.duration ?? 340) + 100)
        })
      })
    },
    cancel() {
      if (settled) return
      cancelled = true
      settle('cancelled')
    },
  }
}
