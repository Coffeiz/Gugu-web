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

const layoutOwners = new WeakMap<HTMLElement, symbol>()

interface LayoutStyleSnapshot {
  height: string
  opacity: string
  transition: string
  overflow: string
  marginTop?: string
  writtenHeight: string
  writtenOpacity: string
  writtenTransition: string
  writtenOverflow: string
  writtenMarginTop?: string
}

export function createDrawerLayoutTransaction(element: HTMLElement, duration = 380, easing = 'cubic-bezier(.22,1,.36,1)'): DrawerLayoutTransaction {
  const token = Symbol('drawer-layout-transaction')
  let snapshot: LayoutStyleSnapshot | null = null
  let cancelled = false
  let timer: number | null = null
  let resolvePlay: ((result: FlipResult) => void) | null = null
  const finish = (result: FlipResult) => {
    if (!resolvePlay) return
    const resolve = resolvePlay
    resolvePlay = null
    if (timer !== null) window.clearTimeout(timer)
    element.removeEventListener('transitionend', onEnd)
    if (layoutOwners.get(element) === token && snapshot) {
      if (element.style.height === snapshot.writtenHeight) element.style.height = snapshot.height
      if (element.style.transition === snapshot.writtenTransition) element.style.transition = snapshot.transition
      layoutOwners.delete(element)
    }
    resolve(result)
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === 'height') finish(cancelled ? 'cancelled' : 'finished')
  }
  return {
    play(targetHeight) {
      if (cancelled) return Promise.resolve('cancelled')
      const current = element.getBoundingClientRect().height
      snapshot = {
        height: element.style.height,
        opacity: element.style.opacity,
        transition: element.style.transition,
        overflow: element.style.overflow,
        writtenHeight: `${current}px`,
        writtenOpacity: element.style.opacity,
        writtenTransition: element.style.transition,
        writtenOverflow: element.style.overflow,
      }
      layoutOwners.set(element, token)
      element.style.height = `${current}px`
      void element.offsetHeight
      element.addEventListener('transitionend', onEnd)
      requestAnimationFrame(() => {
        if (cancelled) return
        element.style.transition = `height ${duration}ms ${easing}`
        const target = `${Math.max(0, targetHeight)}px`
        if (snapshot) snapshot.writtenHeight = target
        if (snapshot) snapshot.writtenTransition = element.style.transition
        element.style.height = target
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
  const token = Symbol('group-layout-transaction')
  let snapshot: LayoutStyleSnapshot | null = null
  let cancelled = false
  let timer: number | null = null
  let resolvePlay: ((result: FlipResult) => void) | null = null
  let isOpening = true
  const cleanup = () => {
    if (timer !== null) window.clearTimeout(timer)
    element.removeEventListener('transitionend', onEnd)
    if (layoutOwners.get(element) !== token || !snapshot) return
    // 收起（!isOpening）时不还原内联样式：元素紧接着就会被 Vue 的 v-if 真正移出 DOM
    // （done() 在调用方的 .finally() 里，比这里晚一拍才触发），若这里把 height 还原成
    // 事务开始前的空字符串，会在真正移除之前先撤销 height:0 的约束，元素瞬间弹回自然
    // 完整高度、又在下一帧被移除——视觉上就是一次几乎被外层 overflow:hidden 裁掉、
    // 只剩一条缝的"高度闪回"。展开场景不受影响：动画终点本来就是自然高度，还原是
    // 安全的空操作。
    if (isOpening) {
      if (element.style.height === snapshot.writtenHeight) element.style.height = snapshot.height
      if (element.style.opacity === snapshot.writtenOpacity) element.style.opacity = snapshot.opacity
      if (element.style.transition === snapshot.writtenTransition) element.style.transition = snapshot.transition
      if (element.style.overflow === snapshot.writtenOverflow) element.style.overflow = snapshot.overflow
      if (snapshot.marginTop !== undefined && element.style.marginTop === snapshot.writtenMarginTop) element.style.marginTop = snapshot.marginTop
    }
    layoutOwners.delete(element)
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
      isOpening = open
      const target = open ? element.scrollHeight : 0
      const current = open ? 0 : element.getBoundingClientRect().height
      // 父容器（.project-group）是 flex column 且带 gap：这个元素只要还挂在 DOM 里、还算一个
      // flex 子项，gap 就会在它和上一个兄弟（分组标题按钮）之间占位，跟它自己的 height 无关。
      // height 动画到 0 时视觉上"看起来收完了"，但 gap 那份空间还在，要等 Vue 真正把它从
      // DOM 移除（v-if 的 leave 完成后）才会消失——多出这一帧才消失的空间就是残留的位移。
      // 用一段等量的负 margin-top 过渡去抵消这份 gap：跟 height 同一个过渡窗口内一起走完，
      // 到收起终点时"height:0 的空间 + gap 的空间 + 负 margin 抵消的空间"净值正好是 0，
      // 之后 DOM 真正移除也不会再有可见变化。展开方向同理反着补一次。
      const parentGap = element.parentElement ? parseFloat(getComputedStyle(element.parentElement).rowGap) || 0 : 0
      const targetMarginTop = open ? 0 : -parentGap
      const currentMarginTop = open ? -parentGap : 0
      snapshot = {
        height: element.style.height,
        opacity: element.style.opacity,
        transition: element.style.transition,
        overflow: element.style.overflow,
        marginTop: element.style.marginTop,
        writtenHeight: `${current}px`,
        writtenOpacity: open ? '0' : '1',
        writtenTransition: element.style.transition,
        writtenOverflow: 'hidden',
        writtenMarginTop: `${currentMarginTop}px`,
      }
      layoutOwners.set(element, token)
      element.style.height = `${current}px`
      element.style.overflow = 'hidden'
      element.style.opacity = open ? '0' : '1'
      if (parentGap > 0) element.style.marginTop = `${currentMarginTop}px`
      void element.offsetHeight
      element.addEventListener('transitionend', onEnd)
      requestAnimationFrame(() => {
        if (cancelled) return
        element.style.transition = parentGap > 0
          ? `height ${duration}ms ${easing}, margin-top ${duration}ms ${easing}, opacity 180ms ease`
          : `height ${duration}ms ${easing}, opacity 180ms ease`
        element.style.height = `${target}px`
        element.style.opacity = open ? '1' : '0'
        if (parentGap > 0) element.style.marginTop = `${targetMarginTop}px`
        if (snapshot) {
          snapshot.writtenHeight = `${target}px`
          snapshot.writtenOpacity = open ? '1' : '0'
          snapshot.writtenTransition = element.style.transition
          snapshot.writtenMarginTop = `${targetMarginTop}px`
        }
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
    // transform 在 transition 结束时会先回到 identity；不能因为它已经不是
    // inverse 值，就跳过 transition 的清理，否则下一笔 FLIP 会继承上一笔的
    // transition，看起来像动画重复播放。
    if (element.style.transform === snapshot.writtenTransform) element.style.transform = snapshot.transform
    if (element.style.transition === snapshot.writtenTransition) element.style.transition = snapshot.transition
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
