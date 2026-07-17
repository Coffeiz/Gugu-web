import { animateFlyTo } from '../animation/flyTo'
import { LandingState } from '../animation/landing'
import { dragRegistry } from '../core/DragRegistry'
import type { DragSession } from '../core/DragSession'
import { integrateSpring } from '../core/physics'
import { resolveLandingZIndex } from '../visual/layer'
import type { CardVisualController } from '../visual/CardVisualController'
import { installDragListeners } from './listeners'
import type { PhysicsDragOpts } from '../useDragEngine'

interface Box { left: number; top: number; width: number; height: number }
interface ActiveDrag { raf: number; end: () => void }

export interface MultiDragDeps {
  active: { current: ActiveDrag | null }
  easing: string
  transparentGhost: () => HTMLCanvasElement
  registerCleanup: (session: DragSession, fn: () => void) => () => void
  visualController: (session: DragSession) => CardVisualController
}

export function startMultiPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, count: number, extras: HTMLElement[] = [], opts: PhysicsDragOpts = {}, deps: MultiDragDeps) {
  if (!sourceEl || deps.active.current) return
  const session = dragRegistry.start(sourceEl)
  const visual = deps.visualController(session)
  session.setPhase('dragging')
  opts.onSessionStart?.(session)
  for (const ex of extras) { if (ex) dragRegistry.cancel(ex) }
  const pointer = opts.pointer === true
  const pointerId = pointer ? (event as PointerEvent).pointerId : null
  if (!pointer) { try { (event as DragEvent).dataTransfer?.setDragImage(deps.transparentGhost(), 0, 0) } catch {} }

  // 上一次拖拽的落地动画要等 transitionend（~420~580ms）才把卡片复位显示，这段窗口期内重新
  // 抓同一批卡会读到 0×0 的 rect、克隆出不可见的卡（同 startPhysicsDrag 的坑，见其注释）。
  // sourceEl 与每个 extras 成员都可能是刚从上一次拖拽落地、还没轮到 finish() 的卡。
  sourceEl.style.display = ''
  sourceEl.style.opacity = ''
  for (const ex of extras) { if (ex) { ex.style.display = ''; ex.style.opacity = '' } }

  const SPRING = opts.spring  ?? 360   // 跟单选一致：调硬跟手（原 190 偏拖沓）
  const ZETA   = opts.damping ?? 0.85
  const LIFT   = opts.lift    ?? 1       // 1=不放大
  const SWAY   = opts.sway    ?? 0.25
  const TILT   = opts.tilt    ?? 5
  const GRABY  = opts.grabY   ?? 28

  const rect = sourceEl.getBoundingClientRect()
  const sourceLayout = getComputedStyle(sourceEl)
  const half = { x: rect.width / 2, y: rect.height / 2 }
  const container = sourceEl.parentElement

  // 影子卡：spread（扇开起始，dx/dy 大偏移让动画明显）→ tight（紧贴叠放，卡片从右下角露出）
  // dx/dy: 相对主克隆左上角的像素偏移；rz: 额外 Z 轴旋转(deg)；sc: 相对 LIFT 的缩放系数
  const SHADOW_CFGS = [
    { spread: { dx: +50, dy: -20, rz: +20, sc: 1.00 }, tight: { dx: +7,  dy: +6,  rz: +4, sc: 0.97 } },
    { spread: { dx: +90, dy: -38, rz: +34, sc: 1.00 }, tight: { dx: +13, dy: +12, rz: +8, sc: 0.94 } },
  ].slice(0, Math.min(count - 1, 2))

  // 读实际卡片圆角，影子卡与主卡保持一致（ProjectModal mode2 / 文件库 card 圆角可能不同）
  const cardRadius = getComputedStyle(sourceEl).borderRadius || '14px'

  const shadows = SHADOW_CFGS.map((cfg, i) => {
    const extraEl = extras[i]
    const initTf =
      `translate3d(${(rect.left + cfg.spread.dx).toFixed(2)}px,` +
      `${(rect.top + half.y - GRABY + cfg.spread.dy).toFixed(2)}px, 0)` +
      ` rotateZ(${cfg.spread.rz.toFixed(2)}deg) scale(${(LIFT * cfg.spread.sc).toFixed(4)})`

    let el: HTMLElement
    const shadowLayout = extraEl ? getComputedStyle(extraEl) : sourceLayout
    if (extraEl) {
      // 克隆真实文件卡内容
      el = visual.cloneForDrag(extraEl)
      // 去掉拖拽状态类；保留 .selected 以保持选中边框和 ::before 覆盖层
      el.classList.remove('pre-selected', 'dragging', 'cut')
      if (opts.cloneClass) el.classList.add(opts.cloneClass)
      // 移除多选框、hover 操作按钮等交互元素，避免「多选模式下样式不一致」
      el.querySelectorAll('.sel-checkbox, .fc-hover-actions, .fd-hover-actions').forEach(n => n.remove())
    } else {
      // 无对应元素时退回空白卡
      el = document.createElement('div')
    }
    el.classList.add('phys-drag-clone')
    Object.assign(el.style, {
      position: 'fixed', left: '0', top: '0',
      // 多选影子也保留原卡的布局宽度/盒模型；不能拿屏幕 rect + border-box 重建，
      // 否则长文件名会在影子卡里提前换行，和主卡/本体不是同一份排版。
      width: shadowLayout.width, height: shadowLayout.height,
      margin: '0', boxSizing: shadowLayout.boxSizing, overflow: 'visible',
      borderRadius: cardRadius,
      // 底色/毛玻璃统一由 global.css 的 .phys-drag-clone 定义（全站拖拽克隆一处控）。不再额外
      // 叠 opacity 做「影子卡更透」——那会跟卡片自己的白底透明度相乘，稀释掉白底，跟单文件拖拽
      // 观感不一致（0.5 白 × 0.35 opacity ≈ 快透明了）。层次感已经靠位置偏移/旋转/缩放/zIndex/
      // box-shadow 表达，不需要再用透明度区分「叠了几张」。
      zIndex: String(99997 - i), pointerEvents: 'none',
      willChange: 'transform', transition: 'none',
      transform: initTf,
      // backdrop-filter 每叠一层都是一次独立的背景采样+高斯模糊，GPU 开销随层数线性上升——
      // 多选拖拽最多叠 3 层（主卡+2 张影子），全做全尺寸模糊太费。只留前两层：紧贴主卡那张
      // （i===0）降到 6px（CSS 默认 12px 的一半），再往后那张（i===1，仅 3+ 文件才会出现）
      // 干脆不模糊——这张本来就压在最底下、被前两张挡掉大半，模糊不模糊肉眼也分不出来。
      // CSS 类里的 backdrop-filter 没加 !important，内联样式能直接覆盖。
      backdropFilter: i === 0 ? 'blur(6px) saturate(1.15)' : 'none',
      WebkitBackdropFilter: i === 0 ? 'blur(6px) saturate(1.15)' : 'none',
    })
    document.body.appendChild(el)
    return { el, cfg }
  })

  // 主克隆（zIndex 最高，带数量徽章）
  const clone = visual.cloneForDrag(sourceEl, { addClasses: ['phys-drag-clone'] })
  // 移除拖拽/剪切态，保留 .selected 以显示选中边框和覆盖层
  clone.classList.remove('dragging', 'cut')
  clone.querySelectorAll('.sel-checkbox, .fc-hover-actions, .fd-hover-actions').forEach(n => n.remove())
  // opts.cloneClass 补回脱离上下文后丢失的版式（如 ProjectModal mode2 的 pm-clone-expanded）
  if (opts.cloneClass) clone.classList.add(opts.cloneClass)
  Object.assign(clone.style, {
    position: 'fixed', left: '0', top: '0',
    width: sourceLayout.width, height: sourceLayout.height,
    margin: '0', boxSizing: sourceLayout.boxSizing, overflow: 'visible',
    borderRadius: cardRadius,
    // 不再叠额外 opacity——底色/毛玻璃由 .phys-drag-clone 全局定义，主克隆跟单文件拖拽走
    // 同一份（CSS 的 opacity:0.97），不用内联值覆盖掉、稀释白底
    zIndex: '99999', pointerEvents: 'none', willChange: 'transform', transition: 'none',
  })
  const badge = document.createElement('div')
  badge.className = 'phys-drag-badge'
  badge.textContent = String(count)
  clone.appendChild(badge)
  clone.style.transform =
    `translate3d(${rect.left.toFixed(2)}px, ${(rect.top + half.y - GRABY).toFixed(2)}px, 0)` +
    ` perspective(760px) rotateX(${TILT}deg) scale(${LIFT})`
  document.body.appendChild(clone)

  document.body.classList.add('phys-dragging')

  // 多文件拖拽：源卡原地不动（保留布局），只有克隆体+影子飞出
  // 单文件 startPhysicsDrag 才做 display:none + FLIP

  const pos    = { x: rect.left + half.x, y: rect.top + half.y }
  const target = { x: pos.x, y: pos.y }
  const vel    = { x: 0, y: 0 }
  let vxs = 0, vys = 0
  const DAMP = 2 * ZETA * Math.sqrt(SPRING)
  const KV   = -Math.log(1 - 0.12) * 60
  let lastT: number | null = null
  let foldT = 0           // 0→1: 折叠进度（扇开→紧贴）
  const FOLD_DUR = 0.30   // 秒

  function onOver(e: PointerEvent | DragEvent) {
    e.preventDefault()
    { const _dt = (e as DragEvent).dataTransfer; if (_dt) _dt.dropEffect = 'move' }
    if (e.clientX || e.clientY) {
      target.x = e.clientX; target.y = e.clientY
      opts.onDragOver?.({ x: e.clientX, y: e.clientY })
    }
  }

  function frame(now: number) {
    if (!session.isCurrent()) return
    let dt = lastT === null ? 1 / 60 : (now - lastT) / 1000
    lastT = now
    if (dt > 1 / 20) dt = 1 / 20

    // 折叠动画进度（ease-out 二次方）
    foldT = Math.min(1, foldT + dt / FOLD_DUR)
    const fold = 1 - Math.pow(1 - foldT, 2)

    // 弹簧积分
    integrateSpring({ position: pos, velocity: vel }, target, SPRING, DAMP, dt)

    const av = 1 - Math.exp(-KV * dt)
    vxs += (vel.x - vxs) * av; vys += (vel.y - vys) * av
    const rotZ = Math.max(-5, Math.min(5, (vxs / 60) * SWAY))
    const rotX = TILT + Math.max(-4, Math.min(4, (vys / 60) * 0.16))

    // 主克隆
    clone.style.transform =
      `translate3d(${(pos.x - half.x).toFixed(2)}px, ${(pos.y - GRABY).toFixed(2)}px, 0)` +
      ` perspective(760px) rotateX(${rotX.toFixed(2)}deg) rotateZ(${rotZ.toFixed(2)}deg) scale(${LIFT})`

    // 影子克隆：spread→tight，并随主克隆一起移动
    for (const { el, cfg } of shadows) {
      const dx = cfg.spread.dx + (cfg.tight.dx - cfg.spread.dx) * fold
      const dy = cfg.spread.dy + (cfg.tight.dy - cfg.spread.dy) * fold
      const rz = cfg.spread.rz + (cfg.tight.rz - cfg.spread.rz) * fold
      const sc = cfg.spread.sc + (cfg.tight.sc - cfg.spread.sc) * fold
      el.style.transform =
        `translate3d(${(pos.x - half.x + dx).toFixed(2)}px, ${(pos.y - GRABY + dy).toFixed(2)}px, 0)` +
        ` perspective(760px) rotateX(${(rotX * 0.6).toFixed(2)}deg)` +
        ` rotateZ(${(rotZ * 0.4 + rz).toFixed(2)}deg) scale(${(LIFT * sc).toFixed(4)})`
    }

    deps.active.current!.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!deps.active.current || !session.isCurrent()) return
    session.setPhase('landing')
    cancelAnimationFrame(deps.active.current.raf)
    deps.active.current = null
    document.body.classList.remove('phys-dragging')
    removeListeners()

    // 影子克隆淡出移除
    for (const { el } of shadows) {
      el.style.transition = 'opacity 0.18s ease'
      el.style.opacity = '0'
      let shadowDone = false
      let unregisterShadow = () => {}
      const removeShadow = () => { if (shadowDone) return; shadowDone = true; unregisterShadow(); el.remove() }
      unregisterShadow = deps.registerCleanup(session, removeShadow)
      setTimeout(removeShadow, 220)
    }

    // 落点用克隆体此刻真实的视觉中心，不用 target/pos——理由同单选版 end()，pos.y 也要修正
    // GRABY 偏移才是视觉中心，见那边的注释。
    const cloneCenter = { x: pos.x, y: pos.y - GRABY + half.y }
    // 多选拖拽（看板/文件库）目前没有消费方需要 turn，固定给 0，不为它另起一套 velHistory。
    // context.pointer 带上原始指针位置——理由同单选版：调用方（dispatchDrop）自己的命中判定
    // 要跟这里下面「吸入文件夹/面包屑」的动画判定用同一个基准点，否则又会出现「动画演了吸入、
    // 数据其实没动」（cloneCenter 是卡片视觉中心，跟指针位置在细长目标上判定结果可能不一致）。
    session.setPhase('resolving-target')
    if (opts.onDrop) { try { opts.onDrop(cloneCenter, { x: vel.x, y: vel.y, turn: 0 }, { w: rect.width, h: rect.height }, { pointer: { x: target.x, y: target.y }, pointerVelocity: { x: 0, y: 0 }, isLandingRegrab: false }) } catch (err) { console.error('[physicsDrag] onDrop failed', err) } }
    session.setPhase('business-committed')

    const dropX = cloneCenter.x, dropY = cloneCenter.y
    const landing = new LandingState(); landing.begin()
    const flyTo = (box: Box, shrink: boolean) => {
      session.setPhase('layout-playing')
      let unregister = () => {}
      const finish = () => {
        if (landing.isDone()) return
        landing.finish()
        unregister()
        clone.remove()
        dragRegistry.finish(sourceEl, session)
      }
      const cancel = animateFlyTo({
        holder: clone,
        box,
        half,
        dropSize: { w: rect.width, h: rect.height },
        shrink,
        fitToTarget: false,
        easing: deps.easing,
        isActive: () => session.isCurrent(),
        onFinish: finish,
      })
      unregister = deps.registerCleanup(session, cancel)
    }

    // 松手即进入归位/落位飞行（见单选 end() 里同名注释 + _landingZIndex）：不再顶着压顶 z，
    // 改按卡片所在的层叠上下文动态取值，避免飞行路径盖住悬浮窗口、也避免被卡片自己所在的浮窗盖住
    clone.style.zIndex = String(resolveLandingZIndex(sourceEl))
    requestAnimationFrame(() => {
      if (!session.isCurrent()) return
      session.setPhase('layout-capturing')
      // 吸入文件夹/面包屑：命中判定用原始指针位置（target.x/y），不用 dropX/dropY（克隆体视觉
      // 中心）——理由同单选版 end()，两者点位不一致会导致「悬停高亮了、一松手却没吸入」。
      const under = document.elementFromPoint(target.x, target.y)
      const absorb = opts.resolveAbsorbTarget
        ? (under && opts.resolveAbsorbTarget(under))
        : under?.closest?.('.folder-card, .bc-item')
      if (absorb) { flyTo(absorb.getBoundingClientRect(), true); return }

      // 归位：克隆体飞回源卡位置并淡出，源卡本身始终可见（多文件模式不隐藏源卡）
      const box = sourceEl.isConnected
        ? sourceEl.getBoundingClientRect()
        : { left: dropX - half.x, top: dropY - half.y, width: rect.width, height: rect.height }
      flyTo(box, false)
    })
  }

  deps.active.current = { raf: 0, end }
  const removeListeners = installDragListeners({
    pointer,
    pointerId,
    source: sourceEl,
    onMove: onOver,
    onEnd: end,
  })
  deps.active.current!.raf = requestAnimationFrame(frame)
}
