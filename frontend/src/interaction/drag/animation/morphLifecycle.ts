import { LandingState } from './landing'
import { morphTransform, type MorphBox } from './morph'
import { trackLandingCamera } from './camera'
import { revealWithoutStaleHover } from '../visual/reveal'
import { installLandingHandoff } from '../interaction/handoff'
import { startThresholdDrag } from '../interaction/threshold'
import type { DragSession } from '../core/DragSession'

export interface MorphLifecycleOptions {
  initialBox: MorphBox
  holder: HTMLElement
  clone: HTMLElement
  clone2: HTMLElement
  revealEl: HTMLElement
  sourceEl: HTMLElement
  connectionDotOverlay?: HTMLElement
  cardActionOverlay?: HTMLElement
  pointer: boolean
  pointerPosition: { x: number; y: number }
  dropSize: { w: number; h: number }
  half: { x: number; y: number }
  easing: string
  trackCanvasCamera: boolean
  contentScale?: () => number
  hidePrimaryVisual: boolean
  revealElConnectable: boolean
  session: DragSession
  registerCleanup: (target: HTMLElement, cleanup: () => void) => () => void
  setRetarget: (target: HTMLElement, retarget: (box: MorphBox) => void) => void
  clearRetarget: (target: HTMLElement, retarget: (box: MorphBox) => void) => void
  onRegrab: (event: PointerEvent, visualRect: DOMRect) => void
  onReveal?: () => void
  finishSession: () => void
}

/** 双克隆落地的完整生命周期；业务目标和接力动作通过回调注入。 */
export function startMorphLifecycle(options: MorphLifecycleOptions): void {
  let box = options.initialBox
  const landing = new LandingState()
  landing.begin()
  let landingHovered = false
  let camGlue: HTMLElement | null = null
  let finishTimer: ReturnType<typeof setTimeout> | null = null
  let unregister: () => void = () => undefined
  let onEnd: (event: TransitionEvent) => void = () => undefined

  const syncHover = (hovering: boolean) => {
    landingHovered = hovering
    options.connectionDotOverlay?.classList.toggle('hovering', options.revealElConnectable && hovering)
    if (options.cardActionOverlay) options.cardActionOverlay.style.opacity = hovering ? '1' : '0'
  }
  const isOverCard = (x: number, y: number) => {
    const rect = options.holder.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }
  const onPointerMove = (event: PointerEvent) => syncHover(isOverCard(event.clientX, event.clientY))

  const cleanupHandoff = installLandingHandoff({
    enabled: options.pointer,
    holder: options.holder,
    clone: options.clone2,
    target: options.revealEl,
    isActive: () => !landing.isDone() && options.session.isCurrent(),
    startThreshold: startThresholdDrag,
    onRegrab: options.onRegrab,
  })
  syncHover(isOverCard(options.pointerPosition.x, options.pointerPosition.y))
  if (options.pointer) document.addEventListener('pointermove', onPointerMove)
  if (options.connectionDotOverlay) {
    options.holder.style.zIndex = String((Number(options.holder.style.zIndex) || 0) + 1)
  }

  const transformFor = (targetBox: MorphBox) => morphTransform(targetBox, options.dropSize, options.half)
  const applyTransform = () => {
    const transform = transformFor(box)
    options.holder.style.transform = transform
    options.clone2.style.transform = transform
  }

  if (options.trackCanvasCamera && options.contentScale) {
    camGlue = document.createElement('div')
    Object.assign(camGlue.style, {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
      transition: 'none', transform: 'translate3d(0,0,0)', pointerEvents: 'none',
      zIndex: options.holder.style.zIndex,
    })
    document.body.appendChild(camGlue)
    camGlue.appendChild(options.holder)
    camGlue.appendChild(options.clone2)
    camGlue.style.transformOrigin = `${options.initialBox.left}px ${options.initialBox.top}px`
    trackLandingCamera({
      revealEl: options.revealEl,
      camGlue,
      origin: options.initialBox,
      isActive: () => !landing.isDone() && options.session.isCurrent(),
    })
  }

  const cloneInner = options.clone
  const clone2Inner = options.clone2.querySelector<HTMLElement>('.phys-landing-content')
  const transition = `transform 0.55s ${options.easing}`
  const fadeTransition = 'opacity 0.42s ease'
  const dragShadow = getComputedStyle(cloneInner).boxShadow
  const landingShadow = clone2Inner ? getComputedStyle(clone2Inner).boxShadow : getComputedStyle(options.revealEl).boxShadow
  cloneInner.style.transition = fadeTransition
  if (clone2Inner) clone2Inner.style.transition = fadeTransition
  options.clone2.style.opacity = '1'
  cloneInner.style.opacity = '0'
  if (clone2Inner) clone2Inner.style.opacity = '1'
  if (options.hidePrimaryVisual) {
    options.holder.style.opacity = '0'
    if (clone2Inner) {
      clone2Inner.style.transition = 'none'
      clone2Inner.style.boxShadow = dragShadow
    }
    void options.clone2.offsetWidth
  }
  if (clone2Inner && dragShadow !== landingShadow) {
    // 落地克隆开始飞行前先继承拖拽强阴影，避免松手瞬间「强阴影→弱阴影」的突变
    const savedTrans = clone2Inner.style.transition
    clone2Inner.style.transition = 'none'
    clone2Inner.style.boxShadow = dragShadow
    void options.clone2.offsetWidth
    clone2Inner.style.transition = savedTrans
  }

  const retarget = (newBox: MorphBox) => {
    if (landing.isDone()) return
    const rect = options.clone2.getBoundingClientRect()
    box = newBox
    const frozen = morphTransform({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, options.dropSize, options.half)
    options.holder.style.transition = 'none'
    options.clone2.style.transition = 'none'
    options.holder.style.transform = frozen
    options.clone2.style.transform = frozen
    requestAnimationFrame(() => {
      if (landing.isDone() || !options.session.isCurrent()) return
      options.holder.style.transition = transition
      options.clone2.style.transition = transition
      applyTransform()
      armFinishTimer()
    })
  }
  options.setRetarget(options.revealEl, retarget)

  const armFinishTimer = () => {
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = setTimeout(finish, 700)
  }
  const finish = () => {
    if (landing.isDone()) return
    landing.finish()
    if (finishTimer) clearTimeout(finishTimer)
    cleanupHandoff()
    if (options.pointer) document.removeEventListener('pointermove', onPointerMove)
    options.clone2.removeEventListener('transitionend', onEnd)
    options.clearRetarget(options.revealEl, retarget)
    unregister()
    options.clone2.style.willChange = 'auto'
    options.clone2.style.width = box.width + 'px'
    options.clone2.style.height = box.height + 'px'
    options.clone2.style.transform = `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px)`
    requestAnimationFrame(() => {
      if (!options.session.isCurrent()) return
      options.holder.remove()
      options.clone2.remove()
      camGlue?.remove()
      options.onReveal?.()
      revealWithoutStaleHover(options.revealEl, options.pointer, undefined, landingHovered, () => options.session.isCurrent())
      options.finishSession()
    })
  }
  const forceCleanup = () => {
    if (landing.isDone()) return
    landing.cancel()
    if (finishTimer) clearTimeout(finishTimer)
    cleanupHandoff()
    if (options.pointer) document.removeEventListener('pointermove', onPointerMove)
    options.clone2.removeEventListener('transitionend', onEnd)
    options.clearRetarget(options.revealEl, retarget)
    options.holder.remove()
    options.clone2.remove()
    camGlue?.remove()
    options.revealEl.classList.add('phys-reveal-snap')
    options.onReveal?.()
    void options.revealEl.offsetWidth
    options.revealEl.classList.remove('phys-reveal-snap')
    revealWithoutStaleHover(options.revealEl, options.pointer, undefined, landingHovered, () => options.session.isCurrent())
    options.finishSession()
  }
  unregister = options.registerCleanup(options.revealEl, forceCleanup)
  onEnd = event => {
    if (event.target === options.clone2 && event.propertyName === 'transform') finish()
  }
  options.clone2.addEventListener('transitionend', onEnd)
  requestAnimationFrame(() => {
    if (landing.isDone() || !options.session.isCurrent()) return
    options.holder.style.transition = transition
    options.clone2.style.transition = transition
    if (clone2Inner && dragShadow !== landingShadow) {
      clone2Inner.style.transition = `box-shadow 0.55s ${options.easing}`
      clone2Inner.style.boxShadow = landingShadow
    }
    applyTransform()
    armFinishTimer()
  })
}
