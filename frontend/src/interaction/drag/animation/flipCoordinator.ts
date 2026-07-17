import type { FlipOptions } from './flip'

export type FlipKey = string | number
export type FlipResult = 'finished' | 'cancelled' | 'stale' | 'skipped'

export interface FlipItem {
  key: FlipKey
  element: HTMLElement
}

export type LayoutRole = 'shell' | 'viewport' | 'track' | 'group' | 'card'

export interface LayoutItem extends FlipItem {
  role: LayoutRole
}

export function createLayoutItems(elements: HTMLElement[], role: LayoutRole): LayoutItem[] {
  return createFlipItems(elements).map(item => ({ ...item, role }))
}

export interface GroupLayoutTransaction {
  play(open: boolean): Promise<FlipResult>
  cancel(): void
}

export interface DrawerLayoutTransaction {
  play(targetHeight: number): Promise<FlipResult>
  cancel(): void
}

export function createDrawerLayoutTransaction(element: HTMLElement, duration = 380, easing = 'cubic-bezier(.22,1,.36,1)'): DrawerLayoutTransaction {
  let cancelled = false
  let timer: number | null = null
  let resolvePlay: ((result: FlipResult) => void) | null = null
  const finish = (result: FlipResult) => {
    if (!resolvePlay) return
    const resolve = resolvePlay
    resolvePlay = null
    if (timer !== null) window.clearTimeout(timer)
    element.removeEventListener('transitionend', onEnd)
    element.style.transition = ''
    resolve(result)
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === 'height') finish(cancelled ? 'cancelled' : 'finished')
  }
  return {
    play(targetHeight) {
      if (cancelled) return Promise.resolve('cancelled')
      const current = element.getBoundingClientRect().height
      element.style.height = `${current}px`
      void element.offsetHeight
      element.addEventListener('transitionend', onEnd)
      requestAnimationFrame(() => {
        if (cancelled) return
        element.style.transition = `height ${duration}ms ${easing}`
        element.style.height = `${Math.max(0, targetHeight)}px`
      })
      return new Promise<FlipResult>(resolve => {
        resolvePlay = resolve
        timer = window.setTimeout(() => finish(cancelled ? 'cancelled' : 'finished'), duration + 100)
      })
    },
    cancel() {
      cancelled = true
      finish('cancelled')
    },
  }
}

/** 负责分组容器的真实像素高度过渡；不触碰 clone、opacity/scale 或业务状态。 */
export function createGroupLayoutTransaction(element: HTMLElement, duration = 280, easing = 'cubic-bezier(.4,0,.2,1)'): GroupLayoutTransaction {
  let cancelled = false
  let timer: number | null = null
  let resolvePlay: ((result: FlipResult) => void) | null = null
  const cleanup = () => {
    if (timer !== null) window.clearTimeout(timer)
    element.removeEventListener('transitionend', onEnd)
    element.style.height = ''
    element.style.opacity = ''
    element.style.transition = ''
    element.style.overflow = ''
  }
  const finish = (result: FlipResult) => {
    if (!resolvePlay) return
    const resolve = resolvePlay
    resolvePlay = null
    cleanup()
    resolve(result)
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === 'height') finish(cancelled ? 'cancelled' : 'finished')
  }
  return {
    play(open) {
      if (cancelled) return Promise.resolve('cancelled')
      const target = open ? element.scrollHeight : 0
      const current = open ? 0 : element.getBoundingClientRect().height
      element.style.height = `${current}px`
      element.style.overflow = 'hidden'
      element.style.opacity = open ? '0' : '1'
      void element.offsetHeight
      element.addEventListener('transitionend', onEnd)
      requestAnimationFrame(() => {
        if (cancelled) return
        element.style.transition = `height ${duration}ms ${easing}, opacity 180ms ease`
        element.style.height = `${target}px`
        element.style.opacity = open ? '1' : '0'
      })
      return new Promise<FlipResult>(resolve => {
        resolvePlay = resolve
        timer = window.setTimeout(() => finish(cancelled ? 'cancelled' : 'finished'), duration + 100)
      })
    },
    cancel() {
      cancelled = true
      finish('cancelled')
    },
  }
}

export interface FlipRetargetBox {
  left: number
  top: number
  width: number
  height: number
}

export interface FlipRetargetRegistry {
  set(element: HTMLElement, callback: (box: FlipRetargetBox) => void): void
  clear(element: HTMLElement, callback: (box: FlipRetargetBox) => void): void
  retarget(elements: HTMLElement[], measure: (element: HTMLElement) => FlipRetargetBox): void
}

const elementKeys = new WeakMap<HTMLElement, number>()
let nextElementKey = 1

/** 为跨分组/重挂载仍存在的元素生成稳定 FLIP key。 */
export function createFlipItems(elements: HTMLElement[]): FlipItem[] {
  return elements.map(element => {
    const key = element.dataset.layoutKey
      ?? element.dataset.projectId
      ?? element.dataset.fileId
      ?? element.dataset.folderKey
      ?? (() => {
        let value = elementKeys.get(element)
        if (!value) {
          value = nextElementKey++
          elementKeys.set(element, value)
        }
        return value
      })()
    return { key, element }
  })
}

/** 在不改变元素当前视觉状态的前提下读取其布局盒。 */
export function measureWithoutTransform(element: HTMLElement): DOMRect {
  const transform = element.style.transform
  const transition = element.style.transition
  element.style.setProperty('transition', 'none', 'important')
  element.style.transform = 'none'
  const rect = element.getBoundingClientRect()
  element.style.transform = transform
  element.style.transition = transition
  return rect
}

/** 集中管理落地飞行动画的目标重定向，避免 engine 自己维护另一套全局注册表。 */
export function createFlipRetargetRegistry(): FlipRetargetRegistry {
  const callbacks = new Map<HTMLElement, (box: FlipRetargetBox) => void>()
  return {
    set(element, callback) {
      callbacks.set(element, callback)
    },
    clear(element, callback) {
      if (callbacks.get(element) === callback) callbacks.delete(element)
    },
    retarget(elements, measure) {
      elements.forEach(element => callbacks.get(element)?.(measure(element)))
    },
  }
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
  ownerAttribute: string | null
  writtenTransform: string
  writtenTransition: string
}

const owners = new WeakMap<HTMLElement, symbol>()
const ownerCancels = new WeakMap<HTMLElement, () => void>()

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
  let phase: 'capturing' | 'measured' | 'playing' | 'settled' = 'capturing'
  let cancelSelf = () => undefined

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
    if (element.getAttribute('data-flip-owner') === 'coordinator') {
      if (snapshot.ownerAttribute === null) element.removeAttribute('data-flip-owner')
      else element.setAttribute('data-flip-owner', snapshot.ownerAttribute)
    }
    owners.delete(element)
    if (ownerCancels.get(element) === cancelSelf) ownerCancels.delete(element)
    snapshots.delete(element)
  }
  const suppressComponentMove = (element: HTMLElement) => {
    const moveClasses = Array.from(element.classList).filter(name => name.endsWith('-move'))
    if (!moveClasses.length) return
    moveClasses.forEach(name => element.classList.remove(name))
    // Vue move 的 inline inverse 只属于组件过渡；去掉后由本事务重新写入唯一 inverse。
    element.style.transform = ''
  }
  const settle = (result: FlipResult) => {
    if (settled) return
    settled = true
    phase = 'settled'
    if (finishTimer !== null) window.clearTimeout(finishTimer)
    pending.forEach(restore)
    pending.clear()
    resolvePlay?.(result)
    resolvePlay = null
  }

  const cancel = () => {
    if (settled) return
    cancelled = true
    settle('cancelled')
  }
  cancelSelf = cancel

  return {
    capture(list, rects) {
      if (!active()) return
      if (phase !== 'capturing') return
      items = new Map(list.map(item => [item.key, item.element]))
      before = read(list, rects)
    },
    measure(list = Array.from(items, ([key, element]) => ({ key, element })), rects) {
      if (!active()) return
      if (phase !== 'capturing') return
      after = read(list, rects)
      items = new Map(list.map(item => [item.key, item.element]))
      phase = 'measured'
    },
    play() {
      if (!active()) return Promise.resolve('stale')
      if (phase !== 'measured') return Promise.resolve('skipped')
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
      phase = 'playing'
      moving.forEach(({ element, dx, dy }) => {
        ownerCancels.get(element)?.()
        suppressComponentMove(element)
        owners.set(element, token)
        ownerCancels.set(element, cancelSelf)
        snapshots.set(element, {
          transform: element.style.transform,
          transition: element.style.transition,
          ownerAttribute: element.getAttribute('data-flip-owner'),
          writtenTransform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`,
          writtenTransition: 'none',
        })
        pending.add(element)
        element.setAttribute('data-flip-owner', 'coordinator')
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
              if (event.target === element && event.propertyName === 'transform' && owners.get(element) === token) {
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
    cancel,
  }
}
