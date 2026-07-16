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
  trackTargetLayout?: boolean
  measureTargetLayout?: () => MorphBox
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
  let targetResizeObserver: ResizeObserver | null = null
  let hasRetargeted = false
  let redirectTimer: ReturnType<typeof setTimeout> | null = null

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
  // 初始调用：只记录落地时的 hover 状态给后面 revealWithoutStaleHover 用，不动
  // connectionDotOverlay 的 hovering 类——它在创建时已从 clone 继承正确的初始状态
  //（startsHovered），这里如果根据 release 瞬间的 isOverCard 重新 toggle，连接点
  // 会先因 holder 坐标微小偏差被摘掉 hovering 类再恢复，在 0.15s transition 窗口内
  // 表现为瞬间消失再淡入。
  landingHovered = options.connectionDotOverlay?.classList.contains('hovering') ?? false
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
  const dragShadow = options.hidePrimaryVisual ? getComputedStyle(cloneInner).boxShadow : ''
  const landingShadow = options.hidePrimaryVisual && clone2Inner ? getComputedStyle(clone2Inner).boxShadow : ''
  cloneInner.style.transition = fadeTransition
  if (clone2Inner) clone2Inner.style.transition = fadeTransition
  // 提交 clone2 的初始布局（opacity:0，与 holder 重叠），确保浏览器在 opacity 变为
  // 1 之前先渲染出初始态——否则浏览器可能把创建和 opacity 设置合并到同一帧，导致
  // clone2 从未以透明状态出现过，落地克隆瞬间取代拖拽克隆，阴影切换没有过渡感。
  // 和 main 分支（usePhysicsDrag.ts:1050）一致。
  options.clone2.getBoundingClientRect()
  // clone2（holder2）创建时 opacity:0，必须同步设为 1——否则 clone2Inner 即使
  // opacity:1 也会因父元素 opacity:0 而不可见，导致松手瞬间两张克隆都透明。
  // 此时 transition 还是创建时的 'none'，所以 opacity 0→1 是瞬间的，和 main 分支一致。
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
  if (options.hidePrimaryVisual && clone2Inner && dragShadow !== landingShadow) {
    // 落地克隆开始飞行前先继承拖拽强阴影，避免松手瞬间「强阴影→弱阴影」的突变
    const savedTrans = clone2Inner.style.transition
    clone2Inner.style.transition = 'none'
    clone2Inner.style.boxShadow = dragShadow
    void options.clone2.offsetWidth
    clone2Inner.style.transition = savedTrans
  }

  // 目标框几乎没动就不算一次改向：ResizeObserver.observe() 注册瞬间会对每个被观察元素
  // 上报一次「初始尺寸」（规范行为，不代表真的发生了 resize），目标卡 + 全祖先链一起注册
  // 会在飞行启动的同一帧收到一整批这种噪音回调；抽屉高度过渡的多数帧里目标卡自身也并
  // 没有位移。不过滤的话，初始批次会把 hasRetargeted 白白烧掉（唯一一次平滑改向被噪音
  // 消耗），后续无位移帧还会反复打断飞行。
  const sameBox = (a: MorphBox, b: MorphBox) =>
    Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5

  // 冻结当前视觉位置 → 下一帧朝 box 重启一段平滑过渡。settle=true 用在连续跟踪收尾的
  // 那次改向：目标只在附近挪了一小段，用短过渡快速贴上去，不把整段飞行拖太长。
  const redirectToBox = (settle: boolean) => {
    const rect = options.clone2.getBoundingClientRect()
    const frozen = morphTransform({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, options.dropSize, options.half)
    options.holder.style.transition = 'none'
    options.clone2.style.transition = 'none'
    options.holder.style.transform = frozen
    options.clone2.style.transform = frozen
    requestAnimationFrame(() => {
      if (landing.isDone() || !options.session.isCurrent()) return
      const t = settle ? `transform 0.25s ${options.easing}` : transition
      options.holder.style.transition = t
      options.clone2.style.transition = t
      applyTransform()
      armFinishTimer()
    })
  }

  const retarget = (newBox: MorphBox) => {
    if (landing.isDone()) return
    if (sameBox(box, newBox)) return
    const continuous = options.trackTargetLayout === true && hasRetargeted
    hasRetargeted = true
    box = newBox
    if (continuous) {
      // 抽屉高度过渡期间目标每帧都在挪：不冻结、不关 transition，直接把新目标写给正在跑的
      // 过渡——CSS transition 的目标被改写时会从当前插值位置平滑转向新目标，缓动前段斜率
      // 大，跟得上每帧几像素的小位移，克隆看起来就是一路追着展开中的落点飞（此前试过"只
      // 记录目标、尾随防抖后再一次改向"：展开期间每帧变化都在重置防抖，settle 直到展开
      // 彻底结束才触发，克隆全程朝旧目标飞、最后补一次可见的跳跃修正，观感就是"先飞向
      // 原本的落点"）。这里显式重设 transition：若恰逢上一次冻结-重启的间隙（transition
      // 还是 none），直接写目标 transform 会变成瞬移。
      options.holder.style.transition = transition
      options.clone2.style.transition = transition
      applyTransform()
      // 突发结束后仍补一次 0.25s 短过渡精确贴合：连续改写目标的过渡不会自然收敛出
      // transitionend（每次改写都在重启），靠这次 settle 收尾并重新武装 finish 计时。
      if (redirectTimer) clearTimeout(redirectTimer)
      redirectTimer = setTimeout(() => {
        redirectTimer = null
        if (landing.isDone() || !options.session.isCurrent()) return
        redirectToBox(true)
      }, 80)
      return
    }
    if (options.trackTargetLayout) {
      // 抽屉展开时的首次改向不能先用 morphTransform 冻结当前矩形：该字符串只包含
      // 位移/缩放，不包含拖拽中的 rotateZ 摆动，会把 clone2 的左右摆动瞬间清零。
      // 直接从当前视觉 transform 过渡到新目标，保留旋转、阴影和尺寸的连续性。
      options.holder.style.transition = transition
      options.clone2.style.transition = transition
      applyTransform()
      armFinishTimer()
      return
    }
    redirectToBox(false)
  }
  options.setRetarget(options.revealEl, retarget)
  if (options.trackTargetLayout && typeof ResizeObserver !== 'undefined') {
    targetResizeObserver = new ResizeObserver(() => {
      if (landing.isDone() || !options.session.isCurrent()) return
      const targetRect = options.measureTargetLayout?.() ?? options.revealEl.getBoundingClientRect()
      retarget(targetRect)
    })
    targetResizeObserver.observe(options.revealEl)
    let ancestor = options.revealEl.parentElement
    while (ancestor && ancestor !== document.body) {
      targetResizeObserver.observe(ancestor)
      ancestor = ancestor.parentElement
    }
  }

  const armFinishTimer = () => {
    if (finishTimer) clearTimeout(finishTimer)
    finishTimer = setTimeout(finish, 700)
  }
  const finish = () => {
    if (landing.isDone()) return
    landing.finish()
    if (finishTimer) clearTimeout(finishTimer)
    if (redirectTimer) clearTimeout(redirectTimer)
    cleanupHandoff()
    targetResizeObserver?.disconnect()
    targetResizeObserver = null
    if (options.pointer) document.removeEventListener('pointermove', onPointerMove)
    options.clone2.removeEventListener('transitionend', onEnd)
    options.clearRetarget(options.revealEl, retarget)
    unregister()
    options.clone2.style.willChange = 'auto'
    // transformFor(box) 已经包含从 dropSize 到目标尺寸的唯一一次缩放；收尾不能
    // 再把内容宽高改成目标尺寸，否则会叠加 scale，揭示本体时出现快速尺寸/位置校正。
    options.clone2.style.width = options.dropSize.w + 'px'
    options.clone2.style.height = options.dropSize.h + 'px'
    options.clone2.style.transform = transformFor(box)
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
    if (redirectTimer) clearTimeout(redirectTimer)
    cleanupHandoff()
    targetResizeObserver?.disconnect()
    targetResizeObserver = null
    if (options.pointer) document.removeEventListener('pointermove', onPointerMove)
    options.clone2.removeEventListener('transitionend', onEnd)
    options.clearRetarget(options.revealEl, retarget)
    options.holder.remove()
    options.clone2.remove()
    camGlue?.remove()
    // 重抓接力时新 session 会立即接管本体和视觉状态。旧 session 只清理自己的
    // 飞行副本，不要同步揭示本体或触发 mouseenter；否则 forceCleanup 与新拖拽
    // 的测量/建克隆会在同一帧串行触发布局，造成可见顿挫。
    if (options.session.isHandoffRequested()) return
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
    if (options.hidePrimaryVisual && clone2Inner && dragShadow !== landingShadow) {
      clone2Inner.style.transition = `box-shadow 0.55s ${options.easing}`
      clone2Inner.style.boxShadow = landingShadow
    }
    applyTransform()
    armFinishTimer()
  })
}
