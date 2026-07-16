import { animateFlyTo } from '../animation/flyTo'
import type { FlipOptions } from '../animation/flip'
import type { FlipTransaction } from '../animation/flipCoordinator'
import { LandingState } from '../animation/landing'
import { startMorphLifecycle } from '../animation/morphLifecycle'
import { dragRegistry } from '../core/DragRegistry'
import type { DragSession } from '../core/DragSession'
import { integrateSpring } from '../core/physics'
import { dispatchDragHandoff } from './handoff'
import { installDragListeners } from './listeners'
import type { PhysicsDragOpts, PhysicsDropContext } from '../useDragEngine'
import { cloneForDrag, createLandingClone } from '../visual/clone'
import { resolveLandingZIndex } from '../visual/layer'

interface Box { left: number; top: number; width: number; height: number }
interface ActiveDrag { raf: number; end: () => void }

function suppressListLandingTransition(el: HTMLElement): () => void {
  const wrapper = el.closest<HTMLElement>('.done-card-item')
  if (!wrapper) return () => undefined
  const classes = ['done-card-list-enter-from', 'done-card-list-enter-active', 'done-card-list-enter-to', 'done-card-list-move']
  const previousTransition = wrapper.style.transition
  const previousTransform = wrapper.style.transform
  classes.forEach(name => wrapper.classList.remove(name))
  wrapper.style.transition = 'none'
  wrapper.style.transform = 'none'
  void wrapper.offsetWidth
  return () => {
    wrapper.style.transition = previousTransition
    wrapper.style.transform = previousTransform
  }
}

const flipElementIds = new WeakMap<HTMLElement, number>()
let nextFlipElementId = 1

function flipItems(elements: HTMLElement[]) {
  return elements.map(element => ({
    key: element.dataset.projectId
      ?? element.dataset.fileId
      ?? element.dataset.folderKey
      ?? (() => {
        let id = flipElementIds.get(element)
        if (!id) {
          id = nextFlipElementId++
          flipElementIds.set(element, id)
        }
        return id
      })(),
    element,
  }))
}

function findVisibleProjectTarget(selector: string, sourceEl: HTMLElement): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
  return candidates.find(el => {
    const inProjectList = !!el.closest('.col-body')
    return el !== sourceEl
      && inProjectList
      && !el.classList.contains('phys-drag-clone')
      && !el.classList.contains('phys-landing-content')
      && el.isConnected
      && el.offsetWidth > 0
      && el.offsetHeight > 0
  }) ?? null
}

function blockScrollDuringLanding(scroller: HTMLElement | null): () => void {
  if (!scroller) return () => undefined
  const preventScroll = (event: Event) => event.preventDefault()
  scroller.addEventListener('wheel', preventScroll, { passive: false })
  scroller.addEventListener('touchmove', preventScroll, { passive: false })
  return () => {
    scroller.removeEventListener('wheel', preventScroll)
    scroller.removeEventListener('touchmove', preventScroll)
  }
}

export interface SingleDragDeps {
  active: { current: ActiveDrag | null }
  easing: string
  createFlipTransaction: (options: FlipOptions) => FlipTransaction
  transparentGhost: () => HTMLCanvasElement
  registerCleanup: (session: DragSession, fn: () => void) => () => void
  setRetarget: (target: HTMLElement, retarget: (box: any) => void) => void
  clearRetarget: (target: HTMLElement, retarget: (box: any) => void) => void
  retargetLandings: (kids: HTMLElement[], rectsIgnored?: any[]) => void
  childCards: (container: HTMLElement, exclude: Element | null, allDescendants?: boolean) => HTMLElement[]
  rects: (elements: Element[]) => DOMRect[]
  scrollParent: (node: Element | null) => HTMLElement | null
  layoutBoxInScroller: (scroller: HTMLElement, target: HTMLElement) => Box
  layoutBoxAtTransitionsEnd: (scroller: HTMLElement | null, target: HTMLElement) => Box
  animateScroll: (el: HTMLElement, dy: number, dur?: number, isActive?: () => boolean) => void
  holdHoverUntilReveal: (el: HTMLElement) => void
  revealWithoutStaleHover: (el: HTMLElement, pointerMode: boolean, onSettled?: () => void, keepControls?: boolean, isActive?: () => boolean) => void
  startPhysicsDrag: (event: PointerEvent, sourceEl: HTMLElement, opts?: PhysicsDragOpts) => void
}

export function startPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, opts: PhysicsDragOpts = {}, deps: SingleDragDeps) {
  if (!(sourceEl instanceof HTMLElement) || deps.active.current) return
  const session = dragRegistry.start(sourceEl)
  session.setPhase('dragging')
  opts.onSessionStart?.(session)
  // 上一次拖拽的落地动画要等 transitionend（~420~580ms）才把这张卡复位显示；这段窗口期内
  // 若重新抓同一张卡，getBoundingClientRect 会在它还是 display:none 时量出 0×0——克隆体宽高
  // 从一开始就定死是 0，看起来「卡片凭空消失」（deps.active.current 只挡真正重叠的拖拽，挡不住这个：
  // 前一次拖拽的 end() 早就把 deps.active.current 清空了，落地动画是它结束后才独立跑的）。抓之前先强制
  // 复位，不管源卡此刻处于什么中间态。
  // 取消旧落地 session 时，揭示收尾可能在本体上留下一个等待下一帧移除的临时类。
  // 重抓必须从干净状态克隆，否则 clone 会继承刚揭示的过渡，原位归还时会出现一帧顿挫。
  sourceEl.classList.remove('phys-drag-source-placeholder', 'phys-just-revealed', 'phys-reveal-snap', 'phys-reveal-controls')
  sourceEl.style.display = ''
  sourceEl.style.opacity = ''
  const pointer = opts.pointer === true
  const pointerId = pointer ? (event as PointerEvent).pointerId : null
  if (!pointer) { try { (event as DragEvent).dataTransfer?.setDragImage(deps.transparentGhost(), 0, 0) } catch {} }

  // 二阶弹簧-阻尼跟随（有惯性/动量，起步被弹簧甩出去而非黏滞渗出）：
  //   SPRING 越大越跟手、越小越拖；ZETA<1 略带动量回弹，=1 临界不过冲。
  const SPRING = opts.spring   ?? 360    // 弹簧刚度（rad²/s²），≈3.0Hz 固有频率（越大越跟手，190 时约 0.35s 追上光标、偏拖沓，调硬到 ~0.23s）
  const ZETA   = opts.damping  ?? 0.85   // 阻尼比：略欠阻尼，保留一点「甩出去」的灵动，但收得比 0.82 快
  const LIFT  = opts.lift      ?? 1       // 克隆抬起的放大（1=不放大）
  const SWAY  = opts.sway      ?? 0.25   // 横向摆动幅度
  const TILT  = opts.tilt      ?? 5      // 后仰角(deg)：上小下大，像被拎起
  const GRABY = opts.grabY     ?? 28     // 抓取点到卡片顶部的距离：挂在指针下方

  const sourceRect = sourceEl.getBoundingClientRect()
  // 落地中再次抓取时，源本体已经在最终布局坐标，肉眼看到的却是 holder 内仍在飞的克隆。
  // 布局/文字尺寸仍以 sourceRect 为准，只有初始屏幕位置取 initialRect；两者混用会把动作
  // 按钮、连接点等相对坐标也错误地减去飞行中的屏幕偏移。
  const initialRect = opts.initialRect ?? sourceRect
  const rect = sourceRect
  // half 用 let：contentScale 是活的（画布相机缩放，抓着卡片不放的时候还能滚轮继续缩放
  // 画布），每帧都可能变，克隆体的实际渲染半宽/半高得跟着重算，见 frame() 里的 _applyCS。
  let half = { x: rect.width / 2, y: rect.height / 2 }
  const container = opts.flipContainer ?? sourceEl.parentElement

  // centerGrab 时抓取点就是 half.y 本身（卡片竖直中心，X 方向本来就已经是 half.x 居中，
  // Y 方向照此对齐），不用 GRABY 那个"顶部往下固定 28px"的量；否则沿用 GRABY——抓起那一刻，
  // 它是这个像素值在当时那个渲染大小下的量，contentScale 是活的时，卡片渲染大小之后可能整体
  // 变了（画布相机缩放），这个绝对像素量不该原封不动继续用：卡片缩小到比它还矮时，抓取点会
  // 被钉在卡片外面，克隆体位置看着就是错的、中心点对不上（"缩放的时候克隆的位置不对"）。
  // liveGrabY 跟着 cloneH 的缩放比例（或 centerGrab 时跟着 half.y 本身）同步变化，保持抓取点
  // 在卡片里"同一个相对位置"，只在 frame() 里 contentScale 变化时才重算。
  let liveGrabY = opts.centerGrab ? half.y : GRABY

  // contentScale 可以传活的取值函数（画布相机缩放会变），也可以传静态数字；不传或恒为 1
  // （绝大多数非画布调用方）时下面这段是 no-op。宽高取源卡的计算布局值而非反推屏幕 rect：
  // 文字换行由这份布局宽度决定，缩放后的浮点尺寸不能拿来重建布局。
  const _resolveCS = () => (typeof opts.contentScale === 'function' ? opts.contentScale() : opts.contentScale) ?? 1
  const CS0 = _resolveCS()
  const sourceStyle = getComputedStyle(sourceEl)
  const cloneW = parseFloat(sourceStyle.width) || (CS0 !== 1 ? sourceRect.width / CS0 : sourceRect.width)
  const cloneH = parseFloat(sourceStyle.height) || (CS0 !== 1 ? sourceRect.height / CS0 : sourceRect.height)
  let lastCS = CS0
  half = { x: (cloneW * CS0) / 2, y: (cloneH * CS0) / 2 }
  liveGrabY = opts.centerGrab ? half.y : GRABY
  // holder 飞行途中可能正被落地 morph 拉伸；再次抓起时先按那一刻的视觉比例画新克隆，再在
  // 抬起的 160ms 内自然收回到本体尺寸，避免中途抓取先突然变大/变小一跳。
  const regrabScale = {
    x: sourceRect.width > 0 ? initialRect.width / sourceRect.width : 1,
    y: sourceRect.height > 0 ? initialRect.height / sourceRect.height : 1,
  }
  let visualScale = { ...regrabScale }

  // holder 只负责屏幕坐标和物理变换；scaleShell 只复现画布相机缩放。克隆保留未缩放的布局宽高，
  // 因而外框、文字、内边距和圆角同步缩放，同时物理 translate3d 的像素坐标不受缩放影响。
  const holder = document.createElement('div')
  Object.assign(holder.style, {
    position: 'fixed', left: '0', top: '0', margin: '0',
    width: rect.width + 'px', height: rect.height + 'px',   // 视觉尺寸，跟 half 假定的一致
    // 拖拽期间的层级默认压过全站几乎所有内容（99999）；画布贴纸单独传低一点的值，让克隆体
    // 飞过侧栏（AppSidebar，z-index:20）那段区域时老实压在侧栏底下，不遮住导航——落地那段
    // 飞行动画（见 end() 的 _landingZIndex）本来就是按上下文动态算的，这里只是把「正在被
    // 抓着走」这段也统一到同一原则，不再无脑扣 99999。
    zIndex: String(opts.dragZIndex ?? 99999), pointerEvents: 'none', willChange: 'transform', transition: 'none',
  })
  // holder 只负责屏幕坐标/物理运动；缩放壳只做 transform 缩放，内容本身保持本体的布局。
  // 这种缩放不参与文本行盒计算，因此拖动时不会临界换行。
  const scaleShell = document.createElement('div')
  Object.assign(scaleShell.style, {
    position: 'absolute', left: '0', top: '0', width: cloneW + 'px', height: cloneH + 'px',
    transformOrigin: '0 0', transform: `scale(${CS0})`, pointerEvents: 'none',
  })
  holder.appendChild(scaleShell)
  const clone = cloneForDrag(sourceEl, {
    addClasses: ['phys-drag-clone'],
  })
  if (opts.cloneClass) clone.classList.add(opts.cloneClass)   // 调用方补回脱离上下文后丢失的版式（如 mode2）
  // 连接点由各贴纸组件的响应式 hovering 状态控制；cloneNode 之后它不再接收组件更新。
  // 用抓起当下真实的命中状态补一次，避免文件/项目/活动卡恰好在组件状态还没刷新时把一份
  // "没有圆点" 的 DOM 克隆出去。便签自身的状态本来就及时，这里也不会改变它的结果。
  const startsHovered = opts.initialHover || sourceEl.matches(':hover')
  clone.classList.remove('phys-reveal-controls')
  if (startsHovered) {
    clone.querySelectorAll<HTMLElement>('.card-conn-dots').forEach(dot => dot.classList.add('hovering'))
  }
  // 连接点不能跟随两张卡片内容克隆交叉淡变：后创建的落地克隆会短暂盖住前一张，圆点便会
  // 在卡片前后切换。把它抽成 holder 内唯一的一层覆盖物；holder 自己全程沿同一条物理轨迹移动，
  // 因而拖拽、落地和回归本体之间没有第二颗点可切换。
  const connectionDotOverlay = clone.querySelector<HTMLElement>('.card-conn-dots')?.cloneNode(true) as HTMLElement | undefined
  clone.querySelectorAll('.card-conn-dots').forEach(dot => dot.remove())
  if (connectionDotOverlay) {
    // 本体里的绝对定位圆点以卡片 padding box 为包含块，会自然避开边框宽度；覆盖层被抽到
    // 没有边框的 scaleShell 后若还用 inset:0，左右圆点会各向外偏一个 border。按源卡真实
    // 边框内缩，克隆与本体的连接点中心落在完全相同的坐标上。
    connectionDotOverlay.style.inset = [
      sourceStyle.borderTopWidth,
      sourceStyle.borderRightWidth,
      sourceStyle.borderBottomWidth,
      sourceStyle.borderLeftWidth,
    ].join(' ')
    // 标记类：全程唯一的连接点覆盖层，套着跟 holder 一致的 rotateZ 摆动。RelationLayer.vue
    // 拖拽/落地飞行期间靠 .phys-conn-dot-overlay[data-node-id] 精确量出它的真实屏幕位置
    // （见其 measuredAnchor），不用另建一份旋转矩阵去猜锚点该在哪。
    connectionDotOverlay.classList.add('phys-conn-dot-overlay')
  }
  // 右上操作区也不能跟两张内容克隆交叉淡变：落地 clone2 会在半程盖住旧 clone，按钮随它
  // 淡出后再由本体补出来，就会像「突然跳出」一样。跟连接点同理，整段拖放只保留这一份
  // 覆盖层；原卡/落地卡里仅隐藏原位副本，保住便签标题行原有的排版宽度。
  const sourceAction = sourceEl.querySelector<HTMLElement>('.card-actions, .nc-actions')
  const cardActionOverlay = sourceAction?.cloneNode(true) as HTMLElement | undefined
  if (sourceAction && cardActionOverlay) {
    const actionRect = sourceAction.getBoundingClientRect()
    const actionStyle = getComputedStyle(sourceAction)
    cardActionOverlay.classList.add('phys-card-actions-overlay')
    Object.assign(cardActionOverlay.style, {
      position: 'absolute',
      left: `${(actionRect.left - rect.left) / CS0}px`,
      top: `${(actionRect.top - rect.top) / CS0}px`,
      right: 'auto', bottom: 'auto', margin: '0',
      width: `${actionRect.width / CS0}px`,
      height: `${actionRect.height / CS0}px`,
      opacity: startsHovered ? '1' : actionStyle.opacity,
      pointerEvents: 'none',
    })
  }
  clone.querySelectorAll<HTMLElement>('.card-actions, .nc-actions').forEach(action => { action.style.visibility = 'hidden' })
  // 清空 left/top/right/bottom（不动 position 本身）：cloneNode(true) 原样带走了源卡的内联
  // 样式——画布贴纸（便签/活动）源卡自己就是 position:absolute + 内联 left/top（世界坐标，
  // 见 stickerStyle），clone 挂进 holder（它自己是 position:fixed，天然是新的定位上下文）后，
  // 若还留着那份世界坐标内联值，就会去 holder 盒子里"世界坐标那个位置"摆自己，而不是老老实实
  // 占满 holder——世界坐标动辄几百上千 px，摆出去早飘到 holder 那个几十几百 px 的小盒子外面，
  // 看着就是"卡片拖起来直接不见了"。项目卡/文件卡不踩这个坑是因为拖的是 .fc-card/.proj-card
  // 本体（position:relative 且没有内联偏移），不是带世界坐标的外层 wrapper。这里只清掉惹祸的
  // 偏移量，position 本身不改——便签/活动贴纸的根节点仍是 position:absolute（class 里定义的，
  // 不是内联），清空 left/top 后 auto 兜底成"正常流位置"（即 holder 里的原点），同时继续
  // 充当自己内部圆点/悬浮按钮等 position:absolute 子元素的定位上下文，不会因为强改成 static
  // 把这些子元素的基准偏移到 holder 身上去。
  Object.assign(clone.style, {
    left: '', top: '', right: '', bottom: '',
    // 文件/项目/活动贴纸的真实根节点带 item.z 内联层级；克隆进 holder 后它只是一张内容卡，
    // 这个旧 z 会在 holder 内反过来压住唯一的连接点覆盖层（便签的 z 在外壳上，故只后三类
    // 会踩）。层级应由 holder/覆盖层统一管理，清掉源卡遗留值。
    zIndex: '', width: cloneW + 'px',
  })
  scaleShell.appendChild(clone)
  if (connectionDotOverlay) {
    scaleShell.appendChild(connectionDotOverlay)
  }
  if (cardActionOverlay) scaleShell.appendChild(cardActionOverlay)
  // 克隆体初始按源卡原始大小(scale 1)摆到源卡位置——避免首帧停在左上角(0,0)闪一下，也避免跟
  // 同一帧刚隐藏的源卡尺寸对不上（source opacity:0 换成 clone 那一刻若已经是 LIFT 放大，观感就是
  // 「抓起来卡片瞬间变大一圈」）。抬起放大改由 frame() 每帧用纯数值渐入（见下面 liftT），不用
  // CSS transition——克隆体从下一帧起全靠 frame() 直接写 transform 保持跟手，留一份 transition
  // 在身上会让每帧的写入都被浏览器重新插值，反而拖慢跟手，且松手瞬间若跟这份 transition 撞车还
  // 会把落地动画写坏（曾经这样实现过，松手时「先放大字体、再突然切回本体」就是这个撞车导致的）。
  const initialCenter = { x: initialRect.left + initialRect.width / 2, y: initialRect.top + initialRect.height / 2 }
  // 普通看板卡沿用 grabY（默认距顶部 28px），pos.y 代表这个抓取点而不是视觉中心；只有
  // centerGrab 才两者相同。飞行中续接若把视觉中心直接塞给 pos.y，下一帧会多出半高-grabY
  // 的偏移，表现为从最终本体位置突然被拉过来。画布中心抓取不显著，项目卡最容易踩到。
  const initialPos = opts.initialRect
    ? { x: initialCenter.x, y: initialCenter.y + liveGrabY - half.y }
    : { x: initialCenter.x, y: initialCenter.y }
  holder.style.transform =
    `translate3d(${(initialPos.x - half.x).toFixed(2)}px, ${(initialPos.y - liveGrabY).toFixed(2)}px, 0)` +
    ` perspective(760px) rotateX(${TILT}deg) scale(${regrabScale.x.toFixed(4)}, ${regrabScale.y.toFixed(4)})`
  document.body.appendChild(holder)

  // 拖拽期间给浏览器减负（性能：trace 显示 CPU 几乎全在浏览器渲染，非物理 JS）：
  //   - 关掉顶栏/侧栏 backdrop-filter：内容一动玻璃就重模糊整条 → 整屏 Paint，拖拽这一两秒不模糊几乎无感；
  //   - 卡片 pointer-events:none：原生拖拽每帧对深层玻璃 DOM 做命中测试很贵，列仍保留以接收原生 drop。
  //   end() 里在 elementFromPoint(文件夹吸附判定) 之前同步摘掉，故不影响落点检测。
  document.body.classList.add('phys-dragging')

  // pointer 模式：把后续 pointermove 全部捕获到 body（源卡随后会 display:none，捕在它身上会丢捕获）。
  // 捕获后浏览器不再为每次移动做命中测试 —— 这正是原生 dragover 省不掉、吃掉 1.3s 的那笔 HitTest。

  // 不修改看板列的 overflow：拖拽期间仍保留滚动条和原生滚动能力，避免列的滚动条消失。

  // 外部素材抽屉保留同尺寸的低透明占位，列表不跳动；普通卡片仍按原逻辑收合让位。
  // 同步 display:none 会让浏览器取消原生拖拽 → 必须下一帧再真正移出布局并做 FLIP。
  if (opts.keepSourcePlaceholder) {
    // 这张卡刚才如果还在飞行中途被抓（比如落地进抽屉的途中重新抓起），上面的
    // DragRegistry.start() 会先取消同源上一趟飞行的 session，forceCleanup 会在此处之前执行。
    // deps.revealWithoutStaleHover 会把本体的 opacity 强制复位成可见——而这里摘掉占位态、
    // 隐藏内容用的 .project-card-body { opacity:0 } 挂着 .16s 的过渡，不是瞬间生效，
    // 会有一段「本体先亮出来、再淡回占位态」的可见闪烁。用跟揭示时同款的
    // .phys-reveal-snap 技巧，把这次切换钉成瞬间生效，不留这段过渡窗口。
    sourceEl.classList.add('phys-reveal-snap')
    sourceEl.classList.add('phys-drag-source-placeholder')
    void sourceEl.offsetWidth
    sourceEl.classList.remove('phys-reveal-snap')
  } else {
    sourceEl.style.opacity = '0'
  }
  if (container && !opts.keepSourcePlaceholder) {
    requestAnimationFrame(() => {
      if (!deps.active.current || !session.isCurrent() || !sourceEl.isConnected) return
      const kids = deps.childCards(container, sourceEl, opts.flipAllDescendants)
      const open = deps.rects(kids)
      sourceEl.style.display = 'none'
      const closed = deps.rects(kids)
      const flip = deps.createFlipTransaction({
        easing: deps.easing,
        onBeforePlay: () => deps.retargetLandings(kids),
        isActive: () => session.isCurrent(),
      })
      const items = flipItems(kids)
      flip.capture(items, open)
      flip.measure(items, closed)
      const unregisterFlipCleanup = deps.registerCleanup(session, () => flip.cancel())
      void flip.play().finally(unregisterFlipCleanup)
    })
  }

  const pos    = { x: initialPos.x, y: initialPos.y }
  const target = { x: pos.x, y: pos.y }
  // pointer 模式起点就是当前指针位置（原生模式靠首个 dragover 校正）
  if (pointer && (event.clientX || event.clientY)) { target.x = event.clientX; target.y = event.clientY }
  // 状态列属于指针意图，而不是视觉克隆的弹簧位置。单独留一份原始指针轨迹，松手时取最近
  // 90ms 的真实速度；视觉速度仍继续只服务卡片的摆动和落地动画，两者不能混用。
  const pointerHistory: { x: number; y: number; t: number }[] = []
  const rememberPointer = (x: number, y: number) => {
    const now = performance.now()
    pointerHistory.push({ x, y, t: now })
    while (pointerHistory.length > 1 && now - pointerHistory[0].t > 140) pointerHistory.shift()
  }
  const recentPointerVelocity = () => {
    if (pointerHistory.length < 2) return { x: 0, y: 0 }
    const last = pointerHistory[pointerHistory.length - 1]
    const startIndex = Math.max(0, pointerHistory.findIndex((sample) => last.t - sample.t <= 90))
    const first = pointerHistory[startIndex]
    const seconds = (last.t - first.t) / 1000
    if (seconds <= 0.003) return { x: 0, y: 0 }
    return {
      x: Math.max(-2400, Math.min(2400, (last.x - first.x) / seconds)),
      y: Math.max(-2400, Math.min(2400, (last.y - first.y) / seconds)),
    }
  }
  if (pointer) rememberPointer(target.x, target.y)
  const vel    = { x: 0, y: 0 }   // 卡片速度 px/秒——二阶弹簧的动量来源
  let vxs = 0, vys = 0            // 平滑后的速度，用于旋转
  // 最近一小段时间的速度采样（各带时间戳），松手时用来判断"甩出去那一刻手腕在不在转弯"——
  // 只看最后一帧的瞬时速度只能给出一个直线方向，抛物线/弧线甩法（手腕带一点转弯）常见，
  // 直接顺着最后瞬时方向甩出去的落点会跟直觉不符。见 end() 里的用法。
  const velHistory: { x: number; y: number; t: number }[] = []
  const VEL_HISTORY_MS = 120

  const DAMP = 2 * ZETA * Math.sqrt(SPRING)   // 阻尼系数（临界=2√k）
  const KV   = -Math.log(1 - 0.12) * 60       // 旋转速度低通（每秒）
  let lastT: number | null = null
  const GROW_MS = 160   // 抓起→抬起(LIFT)的渐入时长，纯时间驱动、跟位置弹簧无关
  let liftT = 0         // 0→1 抬起放大进度，frame() 里推进

  function onOver(e: PointerEvent | DragEvent) {
    // 让整页都成为有效放置区：在任意处（包括拖出范围）松手都立刻触发 drop，
    // 避免无效拖放时浏览器先播放「飞回源」动画、dragend 被推迟 ~250ms 的延迟
    e.preventDefault()
    { const _dt = (e as DragEvent).dataTransfer; if (_dt) _dt.dropEffect = 'move' }
    if (e.clientX || e.clientY) {
      target.x = e.clientX; target.y = e.clientY
      if (pointer) rememberPointer(e.clientX, e.clientY)
      opts.onDragOver?.({ x: e.clientX, y: e.clientY })
    }
  }

  function frame(now: number) {
    if (!session.isCurrent()) return
    // 真实帧间隔（秒）；首帧按 1/60，单帧卡顿/切后台回来则夹住，避免一帧跳一大步
    let dt = lastT === null ? 1 / 60 : (now - lastT) / 1000
    lastT = now
    if (dt > 1 / 20) dt = 1 / 20

    // contentScale 是活的取值函数时，每帧重新读一次当下的画布相机缩放——抓着卡片不放的
    // 时候滚轮还能继续缩放画布，克隆体的视觉大小得跟着变（cloneW/cloneH 这份「世界坐标系
    // 固有尺寸」本身不变，变的是 scaleShell 把它投影到屏幕的比例）。half 跟着重算，否则克隆体
    // 大小变了、但定位仍按旧的半宽半高摆，会偏出指针中心。数值没变时跳过，省一次样式写入。
    if (opts.contentScale != null) {
      const liveCS = _resolveCS()
      if (liveCS !== lastCS) {
        lastCS = liveCS
        scaleShell.style.transform = `scale(${liveCS})`
        half = { x: (cloneW * liveCS) / 2, y: (cloneH * liveCS) / 2 }
        // holder 自己的盒子尺寸不跟着改——它没有背景/边框，"盒子比 clone 实际渲染大小大或
        // 小"不会露出任何视觉破绽（holder 纯粹是定位壳，clone 在里面用 translate3d/half
        // 精确摆好就行，见下面注释）。真正要它保持稳定：end() 里 flyMorph 的落地缩放公式
        // （tfFor）拿 holder 此刻的盒子尺寸当"1.0 倍"基准算 scale 比例——如果这里跟着每帧改，
        // 松手那一刻基准值就是"改到哪算哪"的一个跟画布缩放耦合的数，落地动画的缩放比例会算
        // 错，卡片飞过去时大小/位置都不对。真正"当前应该多大"这份信息由 end() 自己另外从
        // half 重新推一遍（见那边的 dropW/dropH），不依赖 holder 的盒子尺寸。
        // 抓取点也要跟着同一个比例缩放，见 liveGrabY 的定义；centerGrab 时它本来就该恒等于
        // half.y（卡片竖直中心），half 刚更新完，直接跟过去就是，不用再乘缩放比例。
        liveGrabY = opts.centerGrab ? half.y : GRABY * (liveCS / CS0)
      }
    }

    // 子步积分（≤1/120s/步）：显式欧拉在大 dt 下会发散，子步保证弹簧稳定，且与帧率解耦
    integrateSpring({ position: pos, velocity: vel }, target, SPRING, DAMP, dt)

    // 记一帧速度采样，只留最近 VEL_HISTORY_MS 这一小段（时间戳用 now，跟 requestAnimationFrame
    // 的时间基准一致）；开头存的是最老的，取 [0] 就是这段窗口起点的速度，跟当前 vel 一比就知道
    // 这段时间转了多少角度。
    velHistory.push({ x: vel.x, y: vel.y, t: now })
    while (velHistory.length > 1 && now - velHistory[0].t > VEL_HISTORY_MS) velHistory.shift()

    const av = 1 - Math.exp(-KV * dt)
    vxs += (vel.x - vxs) * av; vys += (vel.y - vys) * av
    // 旋转按 px/秒 → 1/60 归一，任何刷新率下后仰/摆动幅度与原先一致
    const rotZ = Math.max(-5, Math.min(5, (vxs / 60) * SWAY))
    const rotX = TILT + Math.max(-4, Math.min(4, (vys / 60) * 0.16))
    // 抬起放大渐入：ease-out cubic，跟位置弹簧一样纯数值驱动，不用 CSS transition
    // （transition 会跟这里每帧的直接写入打架，且松手瞬间容易跟落地动画的 transition 撞车）
    liftT = Math.min(1, liftT + dt * 1000 / GROW_MS)
    const liftEase = 1 - Math.pow(1 - liftT, 3)
    visualScale = {
      x: 1 + (regrabScale.x - 1) * (1 - liftEase),
      y: 1 + (regrabScale.y - 1) * (1 - liftEase),
    }
    const curLift = 1 + (LIFT - 1) * liftEase
    holder.style.transform =
      `translate3d(${(pos.x - half.x).toFixed(2)}px, ${(pos.y - liveGrabY).toFixed(2)}px, 0)` +
      ` perspective(760px) rotateX(${rotX.toFixed(2)}deg) rotateZ(${rotZ.toFixed(2)}deg) ` +
      `scale(${(curLift * visualScale.x).toFixed(4)}, ${(curLift * visualScale.y).toFixed(4)})`
    // 视觉中心跟 end() 里落点用的是同一条公式（pos 本身不是中心，克隆体渲染顶边挂在
    // pos.y - liveGrabY，见 liveGrabY 定义）——onFollow 吐出的必须跟克隆体肉眼所在位置对上，
    // 不能拿 pos 直接充数，否则「线跟着走」会跟卡片实际画面对不齐。
    if (opts.onFollow) opts.onFollow(
      { x: pos.x, y: pos.y - liveGrabY + half.y },
      { w: half.x * 2 * visualScale.x, h: half.y * 2 * visualScale.y },
    )
    deps.active.current!.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!deps.active.current || !session.isCurrent()) return
    session.setPhase('landing')
    cancelAnimationFrame(deps.active.current.raf)
    deps.active.current = null
    document.body.classList.remove('phys-dragging')            // 恢复 backdrop-filter（落点 elementFromPoint 之前）
    removeListeners()

    // 落点用克隆体此刻真实的视觉中心，不用 target（原始指针位置）——弹簧有阻尼延迟，快速
    // 一甩再松手时克隆体还没追上指针，target 会比画面上克隆体的位置更靠前，两者对不上。
    // 注意 pos 本身不是视觉中心：frame() 里克隆体的渲染顶边是 pos.y - liveGrabY（挂在指针
    // 下方 liveGrabY px，contentScale 变化时会跟着按比例缩放，见其定义），不是 pos.y - half.y，
    // 所以真正的视觉中心 y 是 pos.y - liveGrabY + half.y，不能直接拿 pos.y 当中心（拿错会
    // 导致松手位置整体偏移，偏移量正好是 half.y - liveGrabY——卡片越高偏得越多，表现为
    // "松手后卡片往上跳"）。
    const cloneCenter = { x: pos.x, y: pos.y - liveGrabY + half.y }
    // 克隆体此刻真实的视觉尺寸（不是 rect.width/height 那份抓起时刻的旧尺寸）——contentScale
    // 是活的时，抓着卡片不放期间画布缩放可能已经变了好几次，half 由 frame() 全程跟着实时
    // 更新（见那边的注释），到这一刻就是最新、最准的。落地飞行动画（flyMorph 的 tfFor）拿它
    // 当"1.0 倍"的缩放基准，不能再用 rect.width/height——用旧值算出来的缩放比例是"从抓起
    // 时刻的大小缩放到落点"，而克隆体这时候实际已经不是那个大小了，飞过去的动画会跳到错误
    // 的尺寸/位置上。
    // 用 let：落地飞行这 0.55s 期间如果画布还在被缩放（滚轮跟松手同时发生），这两个值也要
    // 跟着实时更新，见 flyMorph 里的 _trackLandingZoom——不然落地动画全程只认松手那一刻的
    // 画布缩放，飞完之后卡片大小跟当下的画布比例对不上。
    let dropW = half.x * 2 * visualScale.x, dropH = half.y * 2 * visualScale.y
    // turn：最近 VEL_HISTORY_MS 这段时间里速度方向转过的角度（弧度，带符号）——甩出去的手腕
    // 不是每次都走直线，这个角度供调用方把惯性延伸的路径也带一点弧度（见 useCardDrag.ts 的
    // coastOffset）。样本太短（刚起手还没攒够历史）或本来就没怎么动时不强算，给 0。
    // 只拿窗口最早/最新各一帧原始采样去比角度会被单帧噪声带偏——尤其是松手前手指几乎停住的
    // 瞬间，瞬时速度方向本来就没什么意义，随手一抖就可能得出一个夸张的转弯角，落点跟着跑偏
    // ("运动方向防抖")。改成拿窗口前半段、后半段各自的平均速度向量再比角度，单帧的抖动会被
    // 同一半段里其它样本平均掉，只有真正持续了一段时间的转向才会被算进 turn 里。
    let turn = 0
    // releaseVel：抛出速度默认退回瞬时 vel（历史样本不够、或本来就没怎么动时，没必要
    // 折腾窗口平均）。够条件时改用窗口后半段（约 VEL_HISTORY_MS/2、~60ms）的平均速度——
    // 不止转弯角度会被松手前一帧的抖动带偏，抛出的方向/力度本身同样会：只看松手那一瞬间
    // 单帧的 vel，手指抬起前哪怕就那一帧因为鼠标抖了一下偏出原本的运动方向，抛出去的卡片
    // 就会跟着径直飞向那个被抖出来的错误方向——跟"转弯角度要防抖"是同一个问题，只是这里
    // 影响的是初始方向而不是过程中的转弯量。
    let releaseVel = { x: vel.x, y: vel.y }
    const speed = Math.hypot(vel.x, vel.y)
    if (velHistory.length > 3 && speed > 30) {
      const mid = velHistory.length >> 1
      const avg = (samples: typeof velHistory) => {
        let sx = 0, sy = 0
        for (const s of samples) { sx += s.x; sy += s.y }
        return { x: sx / samples.length, y: sy / samples.length }
      }
      const early = avg(velHistory.slice(0, mid))
      const late = avg(velHistory.slice(mid))
      const earlySpeed = Math.hypot(early.x, early.y)
      const lateSpeed = Math.hypot(late.x, late.y)
      if (lateSpeed > 30) releaseVel = late
      if (earlySpeed > 30 && lateSpeed > 30) {
        const a1 = Math.atan2(early.y, early.x), a2 = Math.atan2(late.y, late.x)
        turn = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1))
      }
    }
    if (pointer) rememberPointer(target.x, target.y)
    if (opts.onDrop) {
      try {
        opts.onDrop(cloneCenter, { x: releaseVel.x, y: releaseVel.y, turn }, { w: dropW, h: dropH }, {
          pointer: { x: target.x, y: target.y },
          pointerVelocity: pointer ? recentPointerVelocity() : { x: 0, y: 0 },
          isLandingRegrab: opts.isLandingRegrab === true,
        })
      } catch (err) { console.error('[physicsDrag] onDrop failed', err) }
    }

    const dropX = cloneCenter.x, dropY = cloneCenter.y
    const idAttr = sourceEl.getAttribute('data-file-id')    ? ['data-file-id',    sourceEl.getAttribute('data-file-id')]
                 : sourceEl.getAttribute('data-folder-key') ? ['data-folder-key', sourceEl.getAttribute('data-folder-key')]
                 : sourceEl.getAttribute('data-project-id') ? ['data-project-id', sourceEl.getAttribute('data-project-id')]
                 : null
    const sel = idAttr ? `[${idAttr[0]}="${idAttr[1]}"]` : null

    const landing = new LandingState(); landing.begin()
    let onEnd: (e: TransitionEvent) => void = () => {}
    // 只摘占位样式（class + display），不碰 opacity——配合 flyMorph/flyTo 里紧跟着执行的
    // deps.revealWithoutStaleHover 用：那个函数自己会在"先压住 hover 判定、再放开 opacity"
    // 这个正确顺序里把 opacity 复位。如果这里也顺手把 opacity 一起复位了，opacity 会在
    // 压制类还没加上之前就变化，且现在这个属性又挂了 CSS transition（渐变淡出那次改的），
    // 于是这段揭示会在没有压制的窗口期里播一段"正常揭示"过渡——鼠标压在原地时 hover 判定
    // 没被按住，卡片会立刻弹起来，等于绕开了 deps.revealWithoutStaleHover 本该挡住的那层保护。
    const restoreSourcePlaceholderStyle = () => {
      if (!opts.keepSourcePlaceholder) return
      sourceEl.classList.remove('phys-drag-source-placeholder')
      sourceEl.style.display = ''
    }
    // 完整版：摘样式 + 复位 opacity，给没有配套 deps.revealWithoutStaleHover（同一个元素）的
    // 调用点用——目前只有"外部落点成功、抽屉源卡不是落点本体"那条分支（见 resolveLandingTarget
    // 里的用法），那里就是要让抽屉卡直接用自己的 CSS 短淡入复原，不需要也没有额外的
    // hover 压制流程。
    const restoreSourcePlaceholder = () => {
      restoreSourcePlaceholderStyle()
      if (!opts.keepSourcePlaceholder) return
      sourceEl.style.opacity = ''
    }

    // 单克隆用于传统的“缩小吸入”、无目标归位，以及外部抽屉卡回到自己的源位。
    // 后一种源/目标是同一个 DOM、外观也完全相同；再建 clone2 会把源占位与落地克隆并行，
    // 在某些缩放比例下多出一条飞往左上角的残影。
    const flyTo = (box: Box, shrink: boolean, revealEl?: HTMLElement) => {
      if (revealEl) {
        deps.holdHoverUntilReveal(revealEl)
        revealEl.style.opacity = '0'
      }
      let unregister = () => {}
      const finish = () => {
        if (landing.isDone()) return
        landing.finish()
        unregister()
        holder.remove()
        // 先摘占位 class 再揭示：同 flyMorph 里 finish()/forceCleanup 的道理，避免揭示瞬间
        // 先闪一下虚线描边、再过渡回实线的中间态被看见。
        restoreSourcePlaceholder()
        if (revealEl) deps.revealWithoutStaleHover(revealEl, pointer, undefined, false, () => session.isCurrent())
        dragRegistry.finish(sourceEl, session)
      }
      const cancel = animateFlyTo({
        holder,
        box,
        half,
        dropSize: { w: dropW, h: dropH },
        shrink,
        easing: deps.easing,
        isActive: () => session.isCurrent(),
        onFinish: finish,
      })
      unregister = deps.registerCleanup(session, cancel)
    }

    // 双克隆样式渐变：clone(旧样式) 与 clone2(新样式) 同起点、同轨迹飞向落点，飞行途中：
    //  ① 用 scale 把卡片实际拉伸/缩短到落点卡的尺寸（长短按需变化，而非靠淡变蒙混）；
    //  ② 交叉淡变完成内容（旧→新样式）。看到的是飞动的卡片自己变形+变样式并落位。
    const flyMorph = (
      initialBox: Box,
      revealEl: HTMLElement,
      clone2: HTMLElement,
      onReveal?: () => void,
      trackCanvasCamera = true,
      hidePrimaryVisual = false,
      // 连接点覆盖层是从 sourceEl（拖起的源卡）克隆出来的，跟落点是画布卡还是抽屉卡无关——
      // 落到抽屉（比如项目卡拖回项目抽屉）时目标压根不支持建立连线，这份覆盖层理应全程不
      // 出现，但 syncConnectionOverlayHover 之前不管落点类型一律照常根据鼠标位置切换
      // hovering，导致鼠标恰好停在飞行克隆上时连接点一直亮着，直到 finish() 摘掉 holder
      // 才随之消失，表现为"点一直显示到本体切换才突然消失"。落地目标不支持连线时传 false。
      revealElConnectable = true,
      trackTargetLayout = false,
      measureTargetLayout = undefined,
    ) => {
      startMorphLifecycle({
        initialBox,
        holder,
        clone,
        clone2,
        revealEl,
        sourceEl,
        connectionDotOverlay,
        cardActionOverlay,
        pointer,
        pointerPosition: target,
        dropSize: { w: dropW, h: dropH },
        half,
        easing: deps.easing,
        trackCanvasCamera,
        contentScale: typeof opts.contentScale === 'function' ? opts.contentScale : undefined,
        hidePrimaryVisual,
        revealElConnectable,
        session,
        registerCleanup: (_target, cleanup) => deps.registerCleanup(session, cleanup),
        setRetarget: deps.setRetarget,
        clearRetarget: deps.clearRetarget,
        onRegrab: (moveEvent, visualRect) => {
          opts.onRegrabStart?.()
          session.prepareHandoff()
          if (opts.delegateLandingRegrab && revealEl !== sourceEl) {
            if (dispatchDragHandoff(revealEl, moveEvent, visualRect)) {
              dragRegistry.finish(sourceEl, session)
              return
            }
            return
          }
          deps.startPhysicsDrag(moveEvent, revealEl, {
            ...opts,
            // 跨列落地后 Vue 可能已把目标卡挂到另一列；重抓不能沿用首段拖拽
            // 保存的旧 flipContainer，否则新 session 会在旧列测量，目标列 FLIP
            // 前后 rect 全相同，表现为让位和归位瞬移。
            flipContainer: revealEl.closest<HTMLElement>('.kanban-card-list')
              ?? revealEl.closest<HTMLElement>('.col-body')
              ?? opts.flipContainer,
            keepSourcePlaceholder: revealEl === sourceEl ? opts.keepSourcePlaceholder : false,
            initialRect: visualRect,
            initialHover: true,
            isLandingRegrab: true,
          })
        },
        onReveal,
        finishSession: () => dragRegistry.finish(sourceEl, session),
        trackTargetLayout,
        measureTargetLayout,
      })
      return
    }
    // 占位重新展开：FLIP 邻居从「合拢」动到「展开」。el 当前可能已收合(home)或已展开(落点新卡)，
    // 两种都要先拿到 closed 和 open 两套位置
    const animateOpen = (cont: HTMLElement, el: HTMLElement) => {
      const sibs = deps.childCards(cont, el, opts.flipAllDescendants)
      let closedR, openR
      if (el.style.display === 'none') {   // 已收合（home）：量 closed → 展开 → 量 open
        closedR = deps.rects(sibs)
        el.style.display = ''
        openR = deps.rects(sibs)
      } else {                              // 已展开（落点新卡已插入）：量 open → 临时收合量 closed → 复原
        openR = deps.rects(sibs)
        el.style.display = 'none'
        closedR = deps.rects(sibs)
        el.style.display = ''
      }
      deps.holdHoverUntilReveal(el)
      el.style.opacity = '0'              // 落定前隐藏且压住 hover，克隆体落到位再露出
      const flip = deps.createFlipTransaction({
        easing: deps.easing,
        onBeforePlay: () => deps.retargetLandings(sibs),
        isActive: () => session.isCurrent(),
      })
      const items = flipItems(sibs)
      flip.capture(items, closedR)
      flip.measure(items, openR)
      const unregisterFlipCleanup = deps.registerCleanup(session, () => flip.cancel())
      void flip.play().finally(unregisterFlipCleanup)   // 从合拢 → 展开
      return el.getBoundingClientRect()
    }

    // 落点若在可滚动列里滚出视口 → 快速滚进可视区，并返回滚动后的最终落点（让克隆体飞到那里）
    const revealInScroller = (sc: HTMLElement | null, box: Box): Box => {
      if (!sc) return box
      const r = sc.getBoundingClientRect(), pad = 6
      const boxBottom = box.top + box.height
      let dy = boxBottom + pad > r.bottom ? boxBottom + pad - r.bottom
             : box.top - pad < r.top ? box.top - pad - r.top : 0
      const maxDown = sc.scrollHeight - sc.clientHeight - sc.scrollTop
      dy = dy > 0 ? Math.min(dy, maxDown) : Math.max(dy, -sc.scrollTop)
      if (Math.abs(dy) <= 1) return box
      deps.animateScroll(sc, dy, 300, () => session.isCurrent())
      return { left: box.left, top: box.top - dy, width: box.width, height: box.height }
    }

    // 松手即进入「归位/落位」飞行动画（0.55~0.7s）。飞行途中克隆体仍是 fixed 定位，
    // 若继续顶着抓取时的压顶 z(99999)，飞行路径经过悬浮窗口（文件预览/咕咕聊天，20000+ 那一带）
    // 时会整个盖住窗口，动画结束克隆体一 remove 又突然消失——观感是「窗口被糊一下又露出来」。
    // 松手这一刻起改用低 z：默认只需盖过页面里同层的兄弟卡片（自然堆叠序≈0）；卡片若活在
    // 浮窗/弹层里（如项目编辑卡）则动态探测那个浮窗自己的 z，见 _landingZIndex 注释。
    // opts.dragZIndex 传了就直接用它，不走这套按祖先动态探测的启发式——画布贴纸自己紧挨着
    // 摆着一份内联 z-index（item.z，随建卡数量单调递增，见 stickerStyle），探测很容易先摸到
    // 它而不是 .mind-canvas 本身，item.z 一旦长到超过侧栏的 20 又会飞回「压住导航」的老问题；
    // 直接钉死一个数，抓起和落地这两段飞行也不会因为走了两套不同算法而在交接时跳一下层级。
    holder.style.zIndex = String(opts.dragZIndex ?? resolveLandingZIndex(sourceEl))
    // 业务 drop + Vue 重渲染在微任务里已落定；本 rAF 在 paint 前做落点 FLIP，避免闪一下
    requestAnimationFrame(() => {
      if (!session.isCurrent()) return
      // 1) 释放点压着文件夹/面包屑 → 吸入（不依赖异步重渲染）
      //    skipAbsorb（看板）跳过：看板永不吸入文件夹，而此处 elementFromPoint 在 moveProject 把布局改脏后
      //    会强制一次整页重排（trace 里 elementFromPoint 161ms 的大头）——白白吃掉松手那帧。
      let absorbTarget: HTMLElement | null = null
      let cachedAbsorbLayoutSize: { width: number; height: number } | null = null
      if (!opts.skipAbsorb) {
        // 命中判定用「原始指针位置」（target.x/y），不用 cloneCenter（dropX/dropY）——
        // 拖拽过程中 onDragOver 的悬停高亮走的就是原始指针（见其定义处注释），如果这里改用
        // 卡片视觉中心去判定，两者点位不一致：卡片抓取点通常偏卡片上部、卡片本身又比面包屑
        // 这类细长目标高得多，视觉中心会比指针低出「半卡高 - GRABY」那么多，导致「悬停时
        // 面包屑明明亮着、一松手却判定未命中」（面包屑窄条恰好被这段偏移跨过去）。落地动画
        // 仍用 dropX/dropY（卡片视觉中心）摆放，只有这里的命中判定换成指针位置。
        const under = document.elementFromPoint(target.x, target.y)
        const absorb = opts.resolveAbsorbTarget
          ? (under && opts.resolveAbsorbTarget(under))
          : (under && under.closest && under.closest('.folder-card, .bc-item'))
        absorbTarget = absorb as HTMLElement | null
        if (absorbTarget) {
          const targetRect = absorbTarget.getBoundingClientRect()
          const targetStyle = getComputedStyle(absorbTarget)
          cachedAbsorbLayoutSize = {
            width: parseFloat(targetStyle.width) || (lastCS !== 1 ? targetRect.width / lastCS : targetRect.width),
            height: parseFloat(targetStyle.height) || (lastCS !== 1 ? targetRect.height / lastCS : targetRect.height),
          }
        }
      }

      // clone2 不再套 .phys-drag-clone/光晕——直接是目标元素此刻真实 DOM 的克隆，从交叉淡变
      // 一开始就长得跟真卡一样（背景/描边/阴影/文件夹颜色渲染全部原样带过来，不用手动猜数值）。
      // flyMorph 结尾把 revealEl 揭示出来时，clone2 早已跟它像素级一致，不会再有「跳一下」的硬切换。
      // 落地克隆同样拆为 holder2（定位/变换）和 scaleShell（画布缩放）。这样尺寸形变动画不会
      // 改写内容布局，也不会影响屏幕坐标；返回的 holder2 是 flyMorph 接下来操作的 clone2。
      // holder2 用 dropW/dropH（松手那一刻的真实视觉尺寸）不用 rect.width/height（抓起那一刻
      // 的旧尺寸）——contentScale 是活的时两者可能已经不相等（拖拽途中画布被缩放过），tfFor
      // 算缩放比例时也是拿 dropW/dropH 当"1.0 倍"基准，两边必须用同一份，否则落地飞行的尺寸
      // 会算错。scaleShell 同理使用 lastCS（此刻的实时缩放，不是抓起时的 CS0）——cloneW/cloneH
      // 这份"原始尺寸"本身不随缩放变化，仍然沿用抓起时算好的那份。
      const _cloneLanding = (el: HTMLElement) => {
        let targetWidth: number
        let targetHeight: number
        if (el === absorbTarget && cachedAbsorbLayoutSize) {
          targetWidth = cachedAbsorbLayoutSize.width
          targetHeight = cachedAbsorbLayoutSize.height
        } else {
          const targetStyle = getComputedStyle(el)
          const targetRect = el.getBoundingClientRect()
          targetWidth = parseFloat(targetStyle.width) || (lastCS !== 1 ? targetRect.width / lastCS : targetRect.width)
          targetHeight = parseFloat(targetStyle.height) || (lastCS !== 1 ? targetRect.height / lastCS : targetRect.height)
        }
        const landingClone = createLandingClone(el, {
          width: dropW,
          height: dropH,
          layoutWidth: targetWidth,
          layoutHeight: targetHeight,
          zIndex: holder.style.zIndex,
          transform: holder.style.transform,
          contentScale: lastCS,
          cloneClass: opts.cloneClass,
        })
        return landingClone
      }

      if (absorbTarget) {
        // 画布卡默认在工具栏/抽屉下方；确认命中抽屉后才抬到其上方，交给 clone2
        // 播放完整的飞入动画。未命中时保持默认层级，卡片自然落在抽屉层下面。
        if (sourceEl.closest('.mind-canvas') || absorbTarget.closest('[data-project-drawer-dropzone]')) {
          holder.style.zIndex = '31'
        }
        // 画布卡片拖入抽屉时，落地飞行期间锁住抽屉滚动，防止用户滚动导致落点偏移。
        // 在滚动容器上盖一层透明遮罩拦截指针事件（滚轮、拖拽滚动条等），
        // 不修改 overflowY，滚动条保持原样显示。落地后移除。
        // absorbTarget 可能是抽屉容器（画布卡拖入）或源卡自身（抽屉卡放回），
        // .project-list-scroll 在它们内部（不是祖先），不能用 closest 向上查找。
        const drawerScroller = document.querySelector<HTMLElement>('.project-list-scroll')
        const restoreDrawerScroll = blockScrollDuringLanding(drawerScroller)
        // 在 flyTo/flyMorph 启动前注册 cleanup，确保无论动画正常完成还是中途取消
        // 都能恢复抽屉滚动。registerCleanup 在 session terminal 时会同步执行 cleanup。
        deps.registerCleanup(session, restoreDrawerScroll)
        if (opts.absorbShrink ?? true) {
          // 文件/文件夹拖进普通文件夹或面包屑仍是原有的单克隆缩小吸入；目标只是一个
          // 容器入口，不是会被克隆交接的卡片，不能先把它隐藏成 opacity:0。
          flyTo(absorbTarget.getBoundingClientRect(), true)
        } else {
          const deadline = performance.now() + (opts.absorbLandingWaitMs ?? 300)
          const landOnAbsorbTarget = async () => {
            if (!session.isCurrent()) return
            const resolved = opts.resolveAbsorbLandingTarget?.()
            if (!resolved && opts.resolveAbsorbLandingTarget && performance.now() < deadline) {
              requestAnimationFrame(landOnAbsorbTarget)
              return
            }
            // 没传 resolveAbsorbLandingTarget（比如抽屉卡片拖回自己原位，见 ProjectDrawerCard.vue
            // 的 resolveAbsorbTarget 直接返回卡片自身）时，absorbTarget 本身就是精确目标，不存在
            // "轮询等 Vue 挂载新节点"这回事，应该照常走完整的 flyMorph 落地——不能跟"传了但轮询
            // 超时真没找到"混为一谈，否则会把这条本来稳定的路径也退化成缩小动画。只有真正传了
            // resolveAbsorbLandingTarget 却始终没等到时，才需要下面这个安全兜底：不能拿命中判定
            // 用的整个抽屉容器顶替成"假想的落点卡"——那样会把 targetEl.style.opacity 直接摁到 0，
            // 摁的是整个容器，表现就是"抽屉瞬间隐身"（用户会当成"卡片突然变透明"），不是某张卡。
            if (!resolved && opts.resolveAbsorbLandingTarget) {
              flyTo(absorbTarget!.getBoundingClientRect(), true)
              return
            }
            const targetEl = resolved ?? absorbTarget!
            // 外部抽屉卡"放回原位"时，目标就是源占位本身，先压住 opacity 不让它在这一刻
            // 露出来。占位样式（虚线描边）故意留到最后才摘——不在这里提前 classList.remove：
            // 摘早了 _cloneLanding(targetEl) 会把"已经变回本体"的样子克隆进 clone2，飞行
            // 全程看到的就是虚线卡淡出的同时又在变回实卡，两个变化叠在一起很别扭。占位
            // 样式统一交给 restoreSourcePlaceholder（收尾揭示那一刻才调用）来摘，虚线描边
            // 从头到尾保持原样，只在最后揭示本体的瞬间才切换过去。
            if (targetEl === sourceEl && opts.keepSourcePlaceholder) {
              targetEl.style.opacity = '0'
            }
            // 抽屉的 TransitionGroup 正在播放 FLIP 时，getBoundingClientRect() 会包含它的
            // transform，读到的是让位过程中的视觉坐标。改用 offset 链推导最终布局坐标：初始
            // 滚动与 clone2 从第一帧就认同同一个终点，不再等 FLIP 播完后补滚动/反复改向。
            const sc = deps.scrollParent(targetEl)
            // 抽屉来源回到自身时也复用双克隆，完成从画布缩放尺寸回到抽屉实体尺寸的交接。
            // 但落点不在画布内，不能把 fixed 克隆塞进画布相机跟随层；那层会改变其定位基准，
            // 造成额外的左上角残影。
            // trackCanvasCamera 必须恒为 false：这条分支的落点（targetEl）不管是不是同一个
            // DOM，都活在抽屉/侧栏的固定定位坐标系里，从来不在画布相机的世界坐标系内。之前
            // 这里传的是 targetEl !== sourceEl——凡是落到"新挂载的那张具体抽屉卡"（最常见的
            // 那条路径）这个条件就是 true，会给 clone2 套上画布相机跟随层（camGlue，按画布
            // 缩放/平移套一层 transform）。可这层克隆内容根本不在画布世界坐标系里，套错变换
            // 之后经常被挪到看不见的地方或缩没——表现就是"卡片消失几秒钟才突然出现"，长期以来
            // 都是这个恒等式在犯错，不是揭示时机的问题。
            deps.holdHoverUntilReveal(targetEl)
            // 直接改 targetEl.style.opacity 会被它自身的 CSS transition（.25s）接住，变成
            // 一次可见的淡出——这段时间跟刚起飞的 clone2 叠在一起，就是"本体闪一下才淡出"。
            // 这一刻要的是瞬间藏起来（真正的淡出效果交给 clone2 的交叉淡变来演），借用
            // .phys-reveal-snap（揭示时同款技巧）临时关掉过渡、素质提交这一帧，再摘掉快照类。
            targetEl.classList.add('phys-reveal-snap')
            targetEl.style.opacity = '0'
            void targetEl.offsetWidth
            targetEl.classList.remove('phys-reveal-snap')
            // 复用跟 initial box 同一套测量方法（layoutBoxInScroller），不要用
            // layoutBoxWithoutTransforms——抽屉两层 TransitionGroup 做 FLIP 期间，祖先容器
            // 带着内联 transform，而 CSS 规范规定「带 transform 的元素会成为后代的新
            // offsetParent 参照系」；layoutBoxWithoutTransforms 清零祖先 transform 后用
            // getBoundingClientRect() 读，跟 layoutBoxInScroller 的 offsetParent 链走过的
            // 层级不一致，两者算出的相对位移对不上（实测过：同一瞬间、滚动状态完全没变，
            // 两个函数算出的 top 能差出两百多像素），导致克隆体飞到错误位置。
            // 抽屉高度正在用 CSS transition 展开时，逐帧量布局只能拿到中间态、克隆会被动追帧。
            // layoutBoxAtTransitionsEnd 会把祖先链上正在播的过渡临时 seek 到终点量出「展开
            // 结束后」的最终落点再恢复（同一 JS 任务内完成，无绘制、肉眼不可见）——第一次
            // 高度变化触发的 retarget 就直接拿到最终位置，克隆一次平滑改向直达终点，后续
            // 回调因目标不再变化全部被 epsilon 过滤。没有动画在跑时行为等同 layoutBoxInScroller。
            const measureTargetLayout = () => {
              return deps.layoutBoxAtTransitionsEnd(sc, targetEl)
            }
            // 抽屉可能正在展开；首帧就使用展开结束后的目标，避免先按中间盒子创建飞行，
            // 紧接着被 ResizeObserver 改向而重置 clone2 的尺寸和视觉状态。
            const box = revealInScroller(sc, measureTargetLayout())
            flyMorph(
              box,
              targetEl,
              _cloneLanding(targetEl),
              restoreSourcePlaceholderStyle,
              false,
              targetEl === sourceEl,
              // 落点永远是抽屉卡（自己原地放回，或画布卡被吸入抽屉的新卡），抽屉卡不支持
              // 建立连线，连接点覆盖层不该在这段飞行里出现。
              false,
              true,
              measureTargetLayout,
            )
          }
          landOnAbsorbTarget()
        }
        return
      }

      // 拖拽期间需要高于抽屉；松手未命中抽屉后，落地动画改到 UI 下方，避免 clone2
      // 继续遮住抽屉或底部工具栏。命中分支已提前 return，因此不会影响飞入抽屉。
      if (sourceEl.closest('.mind-canvas') || sourceEl.closest('[data-project-drawer-dropzone]')) {
        holder.style.zIndex = '7'
      }

      const landHome = () => {
        // 收合还没来得及发生（极快的拖放）→ 直接归位即可
        if (!container || sourceEl.style.display !== 'none') {
          sourceEl.style.display = ''
          deps.holdHoverUntilReveal(sourceEl)
          sourceEl.style.opacity = '0'
          const sc = deps.scrollParent(sourceEl)
          deps.registerCleanup(session, blockScrollDuringLanding(sc))
          const box = revealInScroller(sc, sourceEl.getBoundingClientRect())
          flyMorph(box, sourceEl, _cloneLanding(sourceEl), restoreSourcePlaceholderStyle)
          return
        }
        // 已收合 → 先占位 FLIP 重新展开源卡，再计算最终归位位置。
        const box0 = animateOpen(container, sourceEl)
        const sc = deps.scrollParent(sourceEl)
        deps.registerCleanup(session, blockScrollDuringLanding(sc))
        const box = revealInScroller(sc, box0)
        flyMorph(box, sourceEl, _cloneLanding(sourceEl), restoreSourcePlaceholderStyle)
      }

      // 外部素材抽屉的卡片在拖拽开始时还不是画布节点；松手后由调用方创建真实卡片，
      // 这里等它挂到 DOM 再交给同一条 morph 管线。惯性已经体现在新节点的最终坐标上，
      // 所以直接 flyMorph 一次即可；不能再先改一段 holder transform，否则两段动画会抢
      // 同一个起点，出现“原地落下”或中途顿一下。失败/超时则完整归位，不能留下隐形源卡。
      if (opts.resolveLandingTarget) {
        const deadline = performance.now() + (opts.landingTargetWaitMs ?? 0)
        const landOnExternalTarget = () => {
          if (!session.isCurrent()) return
          const el = opts.resolveLandingTarget?.()
          if (el?.isConnected && el.offsetWidth > 0) {
            // 素材抽屉的源卡不是落点本体：在新画布卡接手飞行动画时就恢复原位占位，
            // 让它以自身 CSS 的短淡入回到完整素材，而不是长期被 display:none 留空。
            // removeSourceOnExternalDrop=true（比如项目卡拖去画布）时源卡随后会被调用方
            // 从数据里整个移除，交给 Vue 的 TransitionGroup 播放离场——这里不要先复原成
            // 本体样式再等它离场：试过会在抽屉里先闪一下完整卡片本体，才被移除，观感比
            // "虚线占位直接淡出"更突兀。保留跳过复原，占位态本身的 opacity/border-color
            // 过渡（.phys-drag-source-placeholder）已经够呈现一次淡出，不需要在这里先切换
            // 回本体样式。
            if (!opts.removeSourceOnExternalDrop) restoreSourcePlaceholder()
            deps.holdHoverUntilReveal(el)
            el.style.opacity = '0'
            // 抽屉来源卡未命中抽屉时，生成的画布卡应落在抽屉层下方，避免飞行克隆
            // 覆盖抽屉内容。命中抽屉的路径会在上面的 absorb 分支中保留原有层级，正常飞入。
            if (sourceEl.closest('[data-project-drawer-dropzone]')) {
              holder.style.zIndex = '7'
            }
            const box = revealInScroller(deps.scrollParent(el), el.getBoundingClientRect())
            flyMorph(box, el, _cloneLanding(el))
            return
          }
          if (performance.now() < deadline) {
            requestAnimationFrame(landOnExternalTarget)
            return
          }
          landHome()
        }
        landOnExternalTarget()
        return
      }

      // 2) 卡片落到新位置（换列/重排）。Vue 的 keyed v-for 跨列时会复用 sourceEl 本身，
      // 只把它挪到新父容器；不能仅凭 el !== sourceEl 判定“是不是新落点”。否则项目卡跨阶段会
      // 错走旧列归位路径，源卡在克隆飞到新列前提前揭示，鼠标下出现一次陈旧 hover 回弹。
      if (sel) {
        // 看板普通列现在以 .kanban-card-list 作为 FLIP 容器；归位和跨列判定必须使用
        // 同一层级。若一边取 list、一边取 col-body，同列返回会被误判为跨列。
        const projectFlipContainer = (target: HTMLElement) => {
          if (!opts.flipAllDescendants) return target.parentElement!
          return target.closest<HTMLElement>('.kanban-card-list')
            ?? target.closest<HTMLElement>('.col-body')
            ?? target.parentElement!
        }
        const landToProjectTarget = (el: HTMLElement | null, deadline: number) => {
          if (!session.isCurrent()) return
          if (!el && opts.landingVisibilityWaitMs && performance.now() < deadline) {
            requestAnimationFrame(() => landToProjectTarget(document.querySelector<HTMLElement>(sel), deadline))
            return
          }
          // 已完成列的卡片嵌在 year/month/recent 分组中，不能比较直接父节点。
          const movedToAnotherContainer = el
            ? projectFlipContainer(el) !== container
            : false
          if (el && el.isConnected && (el !== sourceEl || movedToAnotherContainer)) {
            const restoreListTransition = suppressListLandingTransition(el)
            if (el.offsetWidth > 0) {   // 落点可见 → 占位 FLIP 展开；双克隆同轨迹飞行 + 样式渐变
            const flipTarget = projectFlipContainer(el)
            animateOpen(flipTarget, el)   // 它为量 FLIP 会瞬间 display:none 落点卡，故滚动放其后
            // 落点在可滚动列里若滚出视口 → 快速滚进可视区，box 取滚动后的最终落点
            const sc = deps.scrollParent(el)
            deps.registerCleanup(session, blockScrollDuringLanding(sc))
            const box = revealInScroller(sc, el.getBoundingClientRect())
            flyMorph(box, el, _cloneLanding(el), restoreListTransition)
              return
            }
            // 状态跨列后，已完成列的年/月分组可能要等 Vue 下一帧才重新挂载；此时不能
            // 把短暂的 0×0 当成“折叠分组”，否则整张卡会错误地缩小淡出。
            if (opts.landingVisibilityWaitMs && performance.now() < deadline) {
              requestAnimationFrame(() => landToProjectTarget(
                findVisibleProjectTarget(sel, sourceEl), deadline,
              ))
              return
            }
            // 落点在确实折叠的分组里不可见 → 就地缩小淡出
            flyTo({ left: dropX - half.x, top: dropY - half.y, width: rect.width, height: rect.height }, true)
            restoreListTransition()
            return
          }
          landHome()
        }
        const deadline = performance.now() + (opts.landingVisibilityWaitMs ?? 0)
        landToProjectTarget(findVisibleProjectTarget(sel, sourceEl), deadline)
        return
      }

      // 3) 没变化 → 归位（原位若在列里滚出视口，也要快速滚回去）。
      landHome()
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

/**
 * 多文件拖拽物理效果（折叠堆叠动画）
 *
 * 在 startPhysicsDrag 基础上叠加「多张卡片折叠成一叠」的视觉：
 *   - 主克隆：同 startPhysicsDrag 的弹簧跟随 + 后仰摆动；
 *   - 影子克隆（最多 2 张）：从「扇开」状态（较大旋转/偏移）ease-out 折叠到「紧贴」状态；
 *   - 右上角数量徽章（.phys-drag-badge）；
 *   - 落点：吸入文件夹 or 归位，影子克隆淡出。
 *
 * @param {DragEvent} event    dragstart 事件
 * @param {HTMLElement} sourceEl  被拖的卡片
 * @param {number} count       选中文件总数（含 sourceEl）
 * @param {object} [opts]      同 startPhysicsDrag opts
 */
/**
 * @param {HTMLElement[]} extras  其余选中文件的 DOM 元素（最多取前 2 张作影子卡）
 */
