/**
 * 拖拽物理效果（项目卡 / 文件卡通用）
 *
 * 原生 HTML5 拖放的 ghost 由浏览器接管，无法做弹簧跟随、占位收合或落点让位。
 * 这里在保留原有拖放逻辑（dragstart/drop 照常）的前提下叠一层视觉物理：
 *   - 拾起：隐藏源卡（克隆体即「本体」跟着指针弹簧跟随、带后仰），源卡占位用 FLIP **动画收合**；
 *   - 落下：飞到实际落点（换列/重排的新槽位），落点容器的其它卡 **FLIP 动画让位**；
 *     文件被收进文件夹/面包屑 → 缩小吸入；没变化 → 占位 FLIP 重新展开、克隆体归位。
 */

// 拖拽物理可选项（startPhysicsDrag / startMultiPhysicsDrag 共用）
interface PhysicsDragOpts {
  pointer?: boolean
  spring?: number
  damping?: number
  lift?: number
  sway?: number
  tilt?: number
  grabY?: number
  cloneClass?: string
  onDrop?: (pos: { x: number; y: number }) => void
  onDragOver?: (pos: { x: number; y: number }) => void   // pointer 模式：每帧回调当前指针位置，供调用方自己 elementFromPoint 判定/高亮落点
  skipAbsorb?: boolean
  // 「吸入文件夹/面包屑」缩小消失动画的目标判定：不传则退回默认的 .folder-card,.bc-item 类名匹配
  // （历史行为）。传了就由调用方决定 under 是否算有效吸入目标、返回该元素（给动画取
  // getBoundingClientRect）或 null——避免组件自己另一套判定和调用方 onDrop 里的判定不一致，
  // 出现"数据没移动、动画却演了吸入消失"的画面和实际状态对不上。
  resolveAbsorbTarget?: (under: Element) => Element | null
}

let _ghostImg = null
function _transparentGhost() {
  if (_ghostImg) return _ghostImg
  // canvas 同步可用（不需要异步解码），避免第一次拖动时 Image 未 ready 导致退回浏览器默认 ghost（favicon）。
  // ⚠️ 必须挂进 DOM（离屏）：脱离 DOM 的 canvas 部分浏览器会忽略 setDragImage → 退回默认小地球 favicon。
  const c = document.createElement('canvas')
  c.width = 1; c.height = 1
  Object.assign(c.style, {
    position: 'fixed', top: '-10px', left: '-10px',
    width: '1px', height: '1px', opacity: '0', pointerEvents: 'none',
  })
  document.body.appendChild(c)
  _ghostImg = c
  return c
}

let _active = null   // 同一时刻只有一个拖拽

// 落地飞行动画（flyTo/flyMorph）跑在独立的 rAF/timeout 里，跟 _active 生命周期不同步——
// end() 一开始就清空 _active，落地动画（0.55~0.7s）还在后台继续。这期间若立刻在原位重新抓
// 同一张卡，startPhysicsDrag 顶部会强制把源卡摆回可见（见下方注释），但上一次拖拽还没落地
// 完的克隆体不会被这一步清掉——于是「已复位的源卡」和「还在飞/还没消失的旧克隆」同屏重叠，
// 看起来像多出一张卡。
// 按「卡片元素」记账（不是全局一刀切）：只有新拖拽抓的正好是同一张卡，才打断它上一趟没放完
// 的落地动画；抓的是别的卡，互不相干的动画不受影响、照常播完——不然随手抓别的文件也会让刚
// 松手的那张瞬间归位，动画被腰斩。
let _pendingCleanups = new Map<HTMLElement, Set<() => void>>()
function _registerCleanup(key: HTMLElement, fn: () => void) {
  let set = _pendingCleanups.get(key)
  if (!set) { set = new Set(); _pendingCleanups.set(key, set) }
  set.add(fn)
  return () => {
    const s = _pendingCleanups.get(key)
    if (!s) return
    s.delete(fn)
    if (!s.size) _pendingCleanups.delete(key)
  }
}
function _flushPendingCleanup(key: HTMLElement | null) {
  if (!key) return
  const set = _pendingCleanups.get(key)
  if (!set) return
  _pendingCleanups.delete(key)
  for (const fn of [...set]) { try { fn() } catch {} }
}

// 卡片飞向落点的途中（0.55s），若同一容器里另一张卡被抓起/放下，触发的 FLIP 会让这张卡的
// 真实落点跟着挪位——飞行动画一开始就把目标钉死成旧位置，不会跟着挪。这里让还在飞的落点
// 动画登记一个「按最新位置重新定目标」的回调（键是 revealEl，即那张卡当前的真实 DOM 元素），
// 每次 _invertPlay 产生一次 FLIP 重排，就用它权威算出的 toRects（真实布局位置，不含过渡中的
// transform 插值，比临时再测一次 getBoundingClientRect 准）去对号更新命中的飞行目标。
// CSS transition 天然支持「途中改目标」：从当前插值位置平滑转向新目标，不会跳变或重播。
let _pendingRetargets = new Map<HTMLElement, (box: any) => void>()
function _retargetLandings(kids: HTMLElement[], rects: any[]) {
  if (!_pendingRetargets.size) return
  kids.forEach((k, i) => {
    const fn = _pendingRetargets.get(k)
    if (fn) fn(rects[i])
  })
}

function _childCards(container, exclude) {
  return [...container.children].filter(c =>
    c.nodeType === 1 && c !== exclude && !c.classList.contains('phys-drag-clone'))
}
const _rects = els => els.map(e => e.getBoundingClientRect())

// 最近的可纵向滚动祖先（兜底：看板/文件库的已知滚动容器，避免 overflow 检测在解锁瞬间抽风）
function _scrollParent(node) {
  // 先试已知滚动容器：一次 closest 命中即返回，省掉逐级 getComputedStyle 遍历。
  // drop 时布局已被 moveProject 改脏，每次 getComputedStyle 都会触发一次强制样式/布局重算（trace: get scrollTop 105ms）。
  const known = node && node.closest && node.closest('.col-body, .files-main')
  if (known && known.scrollHeight > known.clientHeight + 1) return known
  let p = node && node.parentElement
  while (p) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
    p = p.parentElement
  }
  return null
}

// 自己用 rAF 做滚动补间——scrollBy({behavior:'smooth'}) 在某些情况下(reduce-motion / drop 上下文)会退化成瞬间；
// 自实现保证一定有动画，且时长可控（默认 300ms 的快速 ease-out）
function _animateScroll(el, dy, dur = 300) {
  const from = el.scrollTop
  const ease = t => 1 - Math.pow(1 - t, 3)
  let start = null
  const tick = (now) => {
    if (start === null) start = now
    const t = Math.min(1, (now - start) / dur)
    el.scrollTop = from + dy * ease(t)
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// 拾起时源卡正被鼠标悬停着（拖拽即从悬停它开始）。perf trace 实测过两层坑：
// ① 原生拖拽从 dragstart 起整段暂停 mouseover/mouseout 派发——抓起那一刻缓存的 :hover=true
//   全程不会被清掉，只有 pointerout 单独发、没有配对的 mouseout；
// ② 「归位」飞行期间源卡只是 opacity:0（不是 display:none/pointer-events:none，opacity 不影响
//   命中测试），drop 后几毫秒浏览器会自己重新判一次真实 hover，但那距离 opacity 真正揭示出来
//   还有 ~400ms 飞行动画，这段时间指针可能又挪开、也可能邻近卡片 FLIP/重算触发浏览器再切换
//   几次——揭示那一刻用哪个瞬时判定都可能被这些噪音打偏，看着是「跳一下」（.fc-card:hover 的
//   translateY(-2px)）。试过「查实时位置再判定」，噪音太多判不准。
// 原生拖拽下不判定、直接治标：揭示后无条件短暂摘掉命中测试（:hover 物理上不可能生效，不会
// 跳），撑过这段最容易被噪音污染的窗口再完全恢复，交给浏览器按那时的真实指针位置正常判断。
// pointer 模式不走这段——它全程用 pointerdown/pointermove 驱动，浏览器的 mouseover/mouseout
// 派发从没被暂停过，①②两条根因都不成立，:hover 判定一直是准的。若仍套用这段摘命中测试的
// 窗口，会引出另一个新坑：松手时指针原地不动（这正是文件拖完不动手最常见的情形）——窗口期内
// 浏览器正确判定「摘了命中测试=没有 hover」，窗口结束后指针没挪动、没有新 mousemove 触发重新
// 判定，:hover 就永远卡在「没悬停」，实际指针明明正压在卡片上。
// pointer 模式下 :hover 判定本身全程是准的（见上面的注释），但揭示这一刻鼠标可能恰好压在
// 卡片刚落地的位置。要解决的是揭示瞬间的两处「陈旧 hover 态回弹」：卡片飞行期间是 opacity:0
// （命中测试仍在、:hover 已为真），CSS 的 hover 早把整张卡推到了 hover 终态——只是看不见：
//   ① 卡片本体 transform 已在 -2px；② 悬停操作按钮（重命名/下载/删除）opacity 已在 1。
// 若揭示时只恢复 opacity、各自的过渡又都是激活的，卡片会从 -2px 动画回落到压制态 0（下沉）、
// 按钮会从 1 淡出到 0，200ms 后又双双反向动回来——就是「先下沉再上浮」+「按钮闪好几次」。
// 解法：加压制类（把 hover 的 transform/阴影/底色/按钮 opacity 全钉在非 hover 态）的同时，再加
// 一个「快照」类，用 !important 把卡片**及其所有子元素**的 transition 一并关掉；恢复可见、强制
// 提交这一帧——整张卡（含按钮）直接坐在压制态、零动画；随即摘掉快照类恢复过渡（此刻各属性值
// 未变、不会触发任何过渡）。200ms 到点摘掉压制类时，卡片上浮 + 按钮淡入 + 阴影渐显作为一次
// 干净的 hover-in 平滑发生。全程不摘 pointer-events、不碰命中测试，:hover 一直实时准确
// （不会有「指针不动就再也不触发」的坑）。CSS 见 global.css .phys-just-revealed / .phys-reveal-snap。
function _revealWithoutStaleHover(el: HTMLElement, pointerMode: boolean, onSettled?: () => void) {
  el.classList.add('phys-just-revealed')   // 压制：hover 的 transform/阴影/底色/按钮 opacity 全归非 hover 态
  el.classList.add('phys-reveal-snap')     // 快照：本帧关掉卡片+全部子元素的过渡，让上面这步瞬间生效、零动画
  el.style.opacity = ''
  void el.offsetWidth                      // 强制提交：整张卡（含按钮）直接坐在压制态，不下沉、按钮不淡出
  el.classList.remove('phys-reveal-snap')  // 恢复过渡：此刻各属性值未变 → 不触发过渡；只为 200ms 后的上浮/淡入铺路
  setTimeout(() => el.classList.remove('phys-just-revealed'), 200)
  if (pointerMode) { onSettled?.(); return }
  el.style.pointerEvents = 'none'
  setTimeout(() => {
    el.style.pointerEvents = ''
    onSettled?.()
  }, 160)
}

// 到位缓动：强 ease-out（快进慢收，非线性），不过冲、不回弹
const _SETTLE = 'cubic-bezier(0.22, 1, 0.36, 1)'

// 落地飞行阶段用的 z：默认 2（普通页面卡片天然堆叠 ≈0，够盖住兄弟卡片、又远低于
// windowz.ts 的窗口带 20000+，不会在飞行途中把预览器/GuguChat 这类浮窗糊住）。
// 但卡片若本来就活在某个浮窗/弹层里（如项目编辑卡：走 BaseModal，领的 z 本身就在 20000+
// 带），落地时仍用 2 反而比这个浮窗自己的内容更低——克隆体飞行全程被浮窗盖住、肉眼不可见，
// 落地揭示真卡那一刻才「凭空冒出来」，看起来像克隆体半路消失了。
// 这里动态探测：从卡片容器往上找最近一个「真正建立了层叠上下文」的祖先（position 非
// static 且 z-index 是数字，如 BaseModal 的 .bm-center），落地 z 就取它的 z-index+10（+10
// 留出余量，避免同一浮窗里同时有多张卡片在飞、彼此相互覆盖判定不稳）；找不到就说明卡片
// 本来就在普通页面里，退回原来的 2。
function _landingZIndex(el: HTMLElement | null): number {
  let node = el
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    if (cs.position !== 'static' && cs.zIndex !== 'auto') {
      const z = parseInt(cs.zIndex, 10)
      if (!Number.isNaN(z)) return z + 10
    }
    node = node.parentElement
  }
  return 2
}

// FLIP：布局已经变到「现状(toRects)」后，让 kids 先回到 fromRects 再动画到现状
function _invertPlay(kids, fromRects, toRects, dur = 340) {
  _retargetLandings(kids, toRects)
  kids.forEach((c, i) => {
    const dx = fromRects[i].left - toRects[i].left
    const dy = fromRects[i].top  - toRects[i].top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    c.style.transition = 'none'
    c.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
  })
  requestAnimationFrame(() => {
    for (const c of kids) {
      if (!c.style.transform) continue
      c.style.transition = `transform ${dur}ms ${_SETTLE}`
      c.style.transform = ''
      const clr = () => { c.style.transition = ''; c.removeEventListener('transitionend', clr) }
      c.addEventListener('transitionend', clr)
      setTimeout(clr, dur + 80)
    }
  })
}

/**
 * @param {DragEvent|PointerEvent} event  原生 dragstart 事件，或 pointer 模式下越过阈值的 pointermove
 * @param {HTMLElement} sourceEl  被拖的卡片（一般传 event.currentTarget）
 * @param {object} [opts]  { spring, sway, tilt, grabY, lift, pointer, onDrop }
 *   pointer:true 改用 pointer 事件驱动（setPointerCapture 跳过每帧命中测试，省掉原生 dragover 的 HitTest）；
 *   onDrop({x,y}): pointer 模式下松手时回调，由调用方据落点执行业务移动（原生模式靠各列 @drop 落定）。
 */
export function startPhysicsDrag(event, sourceEl, opts: PhysicsDragOpts = {}) {
  if (!sourceEl || _active) return
  _flushPendingCleanup(sourceEl)   // 只打断「同一张卡」上一趟还没飞完的落地动画，避免重叠成「两张卡」
  // 上一次拖拽的落地动画要等 transitionend（~420~580ms）才把这张卡复位显示；这段窗口期内
  // 若重新抓同一张卡，getBoundingClientRect 会在它还是 display:none 时量出 0×0——克隆体宽高
  // 从一开始就定死是 0，看起来「卡片凭空消失」（_active 只挡真正重叠的拖拽，挡不住这个：
  // 前一次拖拽的 end() 早就把 _active 清空了，落地动画是它结束后才独立跑的）。抓之前先强制
  // 复位，不管源卡此刻处于什么中间态。
  sourceEl.style.display = ''
  sourceEl.style.opacity = ''
  const pointer = opts.pointer === true
  const pointerId = pointer ? event.pointerId : null
  if (!pointer) { try { event.dataTransfer?.setDragImage(_transparentGhost(), 0, 0) } catch {} }

  // 二阶弹簧-阻尼跟随（有惯性/动量，起步被弹簧甩出去而非黏滞渗出）：
  //   SPRING 越大越跟手、越小越拖；ZETA<1 略带动量回弹，=1 临界不过冲。
  const SPRING = opts.spring   ?? 190    // 弹簧刚度（rad²/s²），≈2.2Hz 固有频率
  const ZETA   = opts.damping  ?? 0.82   // 阻尼比：略欠阻尼，给一点「甩出去」的灵动
  const LIFT  = opts.lift      ?? 1       // 克隆抬起的放大（1=不放大）
  const SWAY  = opts.sway      ?? 0.25   // 横向摆动幅度
  const TILT  = opts.tilt      ?? 5      // 后仰角(deg)：上小下大，像被拎起
  const GRABY = opts.grabY     ?? 28     // 抓取点到卡片顶部的距离：挂在指针下方

  const rect = sourceEl.getBoundingClientRect()
  const half = { x: rect.width / 2, y: rect.height / 2 }
  const container = sourceEl.parentElement

  // 克隆体（保留 data-v scoped 属性 → 外观一致），它就是飞动的「本体」
  const clone = sourceEl.cloneNode(true) as HTMLElement
  clone.classList.add('phys-drag-clone')
  if (opts.cloneClass) clone.classList.add(opts.cloneClass)   // 调用方补回脱离上下文后丢失的版式（如 mode2）
  Object.assign(clone.style, {
    position: 'fixed', left: '0', top: '0',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', boxSizing: 'border-box',
    zIndex: '99999', pointerEvents: 'none', willChange: 'transform', transition: 'none',
  })
  // 克隆体初始按源卡原始大小(scale 1)摆到源卡位置——避免首帧停在左上角(0,0)闪一下，也避免跟
  // 同一帧刚隐藏的源卡尺寸对不上（source opacity:0 换成 clone 那一刻若已经是 LIFT 放大，观感就是
  // 「抓起来卡片瞬间变大一圈」）。抬起放大改由 frame() 每帧用纯数值渐入（见下面 liftT），不用
  // CSS transition——克隆体从下一帧起全靠 frame() 直接写 transform 保持跟手，留一份 transition
  // 在身上会让每帧的写入都被浏览器重新插值，反而拖慢跟手，且松手瞬间若跟这份 transition 撞车还
  // 会把落地动画写坏（曾经这样实现过，松手时「先放大字体、再突然切回本体」就是这个撞车导致的）。
  clone.style.transform =
    `translate3d(${rect.left.toFixed(2)}px, ${(rect.top + half.y - GRABY).toFixed(2)}px, 0)` +
    ` perspective(760px) rotateX(${TILT}deg) scale(1)`
  document.body.appendChild(clone)

  // 拖拽期间给浏览器减负（性能：trace 显示 CPU 几乎全在浏览器渲染，非物理 JS）：
  //   - 关掉顶栏/侧栏 backdrop-filter：内容一动玻璃就重模糊整条 → 整屏 Paint，拖拽这一两秒不模糊几乎无感；
  //   - 卡片 pointer-events:none：原生拖拽每帧对深层玻璃 DOM 做命中测试很贵，列仍保留以接收原生 drop。
  //   end() 里在 elementFromPoint(文件夹吸附判定) 之前同步摘掉，故不影响落点检测。
  document.body.classList.add('phys-dragging')

  // pointer 模式：把后续 pointermove 全部捕获到 body（源卡随后会 display:none，捕在它身上会丢捕获）。
  // 捕获后浏览器不再为每次移动做命中测试 —— 这正是原生 dragover 省不掉、吃掉 1.3s 的那笔 HitTest。
  if (pointer) { try { document.body.setPointerCapture(pointerId) } catch {} }

  // 拖拽期间锁住看板列的滚动：挡掉浏览器原生拖拽的「边缘自动滚动」——否则列在拖动时就被原生滚到底，
  // 落点时已无可滚（dy≈0），我们的受控平滑滚动跑不起来，看着就是「瞬间到底部」。列用的是 3px overlay
  // 滚动条，overflow:hidden 不会引起布局位移。结束时在 end() 还原。
  const _lockedScrollers = [...document.querySelectorAll<HTMLElement>('.col-body')]
  const _savedScrollTop = new Map()
  for (const s of _lockedScrollers) { _savedScrollTop.set(s, s.scrollTop); s.style.overflowY = 'hidden' }

  // 拾起：先即时透明隐藏源卡（同步 display:none 会让浏览器取消原生拖拽 → 立刻 dragend），
  // 下一帧再真正移出布局并 FLIP 合拢邻居
  sourceEl.style.opacity = '0'
  if (container) {
    requestAnimationFrame(() => {
      if (!_active || !sourceEl.isConnected) return
      const kids = _childCards(container, sourceEl)
      const open = _rects(kids)
      sourceEl.style.display = 'none'
      const closed = _rects(kids)
      _invertPlay(kids, open, closed)
    })
  }

  const pos    = { x: rect.left + half.x, y: rect.top + half.y }
  const target = { x: pos.x, y: pos.y }
  // pointer 模式起点就是当前指针位置（原生模式靠首个 dragover 校正）
  if (pointer && (event.clientX || event.clientY)) { target.x = event.clientX; target.y = event.clientY }
  const vel    = { x: 0, y: 0 }   // 卡片速度 px/秒——二阶弹簧的动量来源
  let vxs = 0, vys = 0            // 平滑后的速度，用于旋转

  const DAMP = 2 * ZETA * Math.sqrt(SPRING)   // 阻尼系数（临界=2√k）
  const KV   = -Math.log(1 - 0.12) * 60       // 旋转速度低通（每秒）
  let lastT = null
  const GROW_MS = 160   // 抓起→抬起(LIFT)的渐入时长，纯时间驱动、跟位置弹簧无关
  let liftT = 0         // 0→1 抬起放大进度，frame() 里推进

  function onOver(e) {
    // 让整页都成为有效放置区：在任意处（包括拖出范围）松手都立刻触发 drop，
    // 避免无效拖放时浏览器先播放「飞回源」动画、dragend 被推迟 ~250ms 的延迟
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (e.clientX || e.clientY) {
      target.x = e.clientX; target.y = e.clientY
      opts.onDragOver?.({ x: e.clientX, y: e.clientY })
    }
  }

  function frame(now) {
    // 真实帧间隔（秒）；首帧按 1/60，单帧卡顿/切后台回来则夹住，避免一帧跳一大步
    let dt = lastT === null ? 1 / 60 : (now - lastT) / 1000
    lastT = now
    if (dt > 1 / 20) dt = 1 / 20

    // 子步积分（≤1/120s/步）：显式欧拉在大 dt 下会发散，子步保证弹簧稳定，且与帧率解耦
    let rem = dt
    while (rem > 1e-4) {
      const h = Math.min(rem, 1 / 120)
      rem -= h
      const ax = SPRING * (target.x - pos.x) - DAMP * vel.x
      const ay = SPRING * (target.y - pos.y) - DAMP * vel.y
      vel.x += ax * h; vel.y += ay * h
      pos.x += vel.x * h; pos.y += vel.y * h
    }

    const av = 1 - Math.exp(-KV * dt)
    vxs += (vel.x - vxs) * av; vys += (vel.y - vys) * av
    // 旋转按 px/秒 → 1/60 归一，任何刷新率下后仰/摆动幅度与原先一致
    const rotZ = Math.max(-5, Math.min(5, (vxs / 60) * SWAY))
    const rotX = TILT + Math.max(-4, Math.min(4, (vys / 60) * 0.16))
    // 抬起放大渐入：ease-out cubic，跟位置弹簧一样纯数值驱动，不用 CSS transition
    // （transition 会跟这里每帧的直接写入打架，且松手瞬间容易跟落地动画的 transition 撞车）
    liftT = Math.min(1, liftT + dt * 1000 / GROW_MS)
    const liftEase = 1 - Math.pow(1 - liftT, 3)
    const curLift = 1 + (LIFT - 1) * liftEase
    clone.style.transform =
      `translate3d(${(pos.x - half.x).toFixed(2)}px, ${(pos.y - GRABY).toFixed(2)}px, 0)` +
      ` perspective(760px) rotateX(${rotX.toFixed(2)}deg) rotateZ(${rotZ.toFixed(2)}deg) scale(${curLift})`
    _active.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!_active) return
    cancelAnimationFrame(_active.raf)
    _active = null
    document.body.classList.remove('phys-dragging')            // 恢复 backdrop-filter（落点 elementFromPoint 之前）
    for (const s of _lockedScrollers) s.style.overflowY = ''   // 解锁列滚动，下面才能受控平滑滚到落点
    if (pointer) {
      document.removeEventListener('pointermove', onOver)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      try { document.body.releasePointerCapture(pointerId) } catch {}
    } else {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', end, true)
      sourceEl.removeEventListener('dragend', end)
    }

    // pointer 模式：落点的业务移动由调用方在此执行（原生模式靠各列 @drop 已落定）。
    // 必须先于下面的落点 FLIP——它要等业务移动触发的 Vue 重渲染把卡片排到新槽位后，再据新 DOM 飞过去。
    if (opts.onDrop) { try { opts.onDrop({ x: target.x, y: target.y }) } catch (err) { console.error('[physicsDrag] onDrop failed', err) } }

    const dropX = target.x, dropY = target.y
    const idAttr = sourceEl.getAttribute('data-file-id')    ? ['data-file-id',    sourceEl.getAttribute('data-file-id')]
                 : sourceEl.getAttribute('data-folder-key') ? ['data-folder-key', sourceEl.getAttribute('data-folder-key')]
                 : sourceEl.getAttribute('data-project-id') ? ['data-project-id', sourceEl.getAttribute('data-project-id')]
                 : null
    const sel = idAttr ? `[${idAttr[0]}="${idAttr[1]}"]` : null

    let done = false, onEnd = null
    const SLOT = box => `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(1)`

    // 单克隆：只用于吸入(shrink)——缩小淡出进文件夹/面包屑，没有「露出真卡」这一步，
    // 不存在克隆→真卡外观不一致的问题。归位/落到新位置一律走下面的 flyMorph（双克隆交叉淡变）。
    const flyTo = (box, shrink) => {
      clone.style.transition = `transform 0.55s ${_SETTLE}, opacity 0.4s ease`
      if (shrink) {
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        clone.style.opacity = '0'
        clone.style.transform =
          `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(0.32)`
      } else {
        clone.style.transform = SLOT(box)
      }
      let unregister = () => {}
      const finish = () => {
        if (done) return
        done = true
        unregister()
        clone.removeEventListener('transitionend', onEnd)
        clone.remove()
      }
      unregister = _registerCleanup(sourceEl, finish)
      onEnd = finish
      clone.addEventListener('transitionend', onEnd)
      setTimeout(finish, 680)
    }

    // 双克隆样式渐变：clone(旧样式) 与 clone2(新样式) 同起点、同轨迹飞向落点，飞行途中：
    //  ① 用 scale 把卡片实际拉伸/缩短到落点卡的尺寸（长短按需变化，而非靠淡变蒙混）；
    //  ② 交叉淡变完成内容（旧→新样式）。看到的是飞动的卡片自己变形+变样式并落位。
    const flyMorph = (initialBox, revealEl, clone2) => {
      // box 用 let：飞行途中可能被 _retargetLandings 改指到新位置（见其注释），finish() 收尾时
      // 要读的是「最新」这份，不是刚进来那一刻的静态快照。
      let box = initialBox
      // 克隆体是按源卡(旧)尺寸渲染的；缩放到落点卡尺寸，并让缩放后中心对齐落点中心
      const applyTransform = () => {
        const sx = (box.width  / rect.width ).toFixed(4)
        const sy = (box.height / rect.height).toFixed(4)
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        const tf = `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0)` +
                   ` perspective(760px) rotateX(0deg) rotateZ(0deg) scale(${sx}, ${sy})`
        clone.style.transform = tf
        clone2.style.transform = tf
      }
      clone2.getBoundingClientRect()   // 提交初始态（与 clone 重叠、opacity 0），下面才会从此处动画
      const trans = `transform 0.55s ${_SETTLE}, opacity 0.42s ease`
      clone.style.transition = trans
      clone2.style.transition = trans
      applyTransform()
      clone.style.opacity = '0'
      clone2.style.opacity = '0.97'

      // 飞行途中容器发生 FLIP 重排（另一张卡被抓起/放下）→ 落点跟着挪位，把目标改过去。
      // 直接在飞行中途改 transform 目标，浏览器会当「打断」处理：新一段插值默认按当前速度
      // 顺势打断续接，而不是重新从静止起步走一遍完整缓出曲线——两段拼起来速度不连续，
      // 观感比原本单段飞行更接近匀速，缓出的「快进慢收」感被削弱。
      // 做法：读出克隆体此刻真实渲染的位置（含插值中的中间态）→ 关过渡、把这个位置钉死成
      // 当前态 → 重新打开过渡、指向新目标，让这一段重新从「静止的当前位置」完整跑一遍同一条
      // 缓出曲线，手感跟原本没被打断时一致。全程同步无绘制帧插入，位置本身不会跳一下。
      const retarget = (newBox) => {
        if (done) return
        box = newBox
        const curT = getComputedStyle(clone2).transform
        clone.style.transition = 'none'
        clone2.style.transition = 'none'
        clone.style.transform = curT
        clone2.style.transform = curT
        void clone2.offsetWidth
        clone.style.transition = trans
        clone2.style.transition = trans
        applyTransform()
      }
      _pendingRetargets.set(revealEl, retarget)

      let unregister = () => {}
      const finish = () => {
        if (done) return
        done = true
        unregister()
        if (_pendingRetargets.get(revealEl) === retarget) _pendingRetargets.delete(revealEl)
        clone2.removeEventListener('transitionend', onEnd)
        // 收尾前把 clone2 钉死成跟 revealEl 完全一致的「纯 2D」状态，排除两种可能的残留误差：
        // ① scale(sx,sy) 是按 box.width/rect.width 算出来的近似值，不保证正好是 1，哪怕差
        //    0.1% 在图标/小字上也会被人眼当成「大小不对」；这里直接钉宽高像素值，不再依赖缩放。
        // ② transform 里的 perspective()/rotateX() 即使角度是 0，仍会把元素留在 3D 渲染/GPU
        //    合成层里，跟 revealEl 的普通 2D 布局渲染方式不同，字重/清晰度有细微差异；这里换成
        //    不带 perspective/rotate 的纯 translate，退出 3D 上下文。连同 will-change 一起清掉，
        //    等一帧生效、彻底长得跟 revealEl 一样了，再切换过去。
        clone2.style.willChange = 'auto'
        clone2.style.width  = box.width  + 'px'
        clone2.style.height = box.height + 'px'
        clone2.style.transform = `translate(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px)`
        requestAnimationFrame(() => {
          clone.remove(); clone2.remove()
          _revealWithoutStaleHover(revealEl, pointer)
        })
      }
      // 被同一张卡的新拖拽强制打断时用（按 revealEl 记账，见 _registerCleanup——只有再次抓的
      // 正是这张卡才会触发）：摘掉两张克隆、同步（非 rAF 延迟）揭示 revealEl，紧接着就被新拖拽
      // 自己的隐藏覆盖掉，全程同步无绘制帧插入，不会闪一下。不做 finish() 里那套「钉死」精修——
      // 反正马上就要整个移除，没必要为一个不会被看到的最终帧计算像素级样式。
      const forceCleanup = () => {
        if (done) return
        done = true
        if (_pendingRetargets.get(revealEl) === retarget) _pendingRetargets.delete(revealEl)
        clone2.removeEventListener('transitionend', onEnd)
        clone.remove(); clone2.remove()
        _revealWithoutStaleHover(revealEl, pointer)
      }
      unregister = _registerCleanup(revealEl, forceCleanup)
      onEnd = finish
      clone2.addEventListener('transitionend', onEnd)
      setTimeout(finish, 700)
    }

    // 占位重新展开：FLIP 邻居从「合拢」动到「展开」。el 当前可能已收合(home)或已展开(落点新卡)，
    // 两种都要先拿到 closed 和 open 两套位置
    const animateOpen = (cont, el) => {
      const sibs = _childCards(cont, el)
      let closedR, openR
      if (el.style.display === 'none') {   // 已收合（home）：量 closed → 展开 → 量 open
        closedR = _rects(sibs)
        el.style.display = ''
        openR = _rects(sibs)
      } else {                              // 已展开（落点新卡已插入）：量 open → 临时收合量 closed → 复原
        openR = _rects(sibs)
        el.style.display = 'none'
        closedR = _rects(sibs)
        el.style.display = ''
      }
      el.style.opacity = '0'              // 落定前隐藏，克隆体落到位再露出
      _invertPlay(sibs, closedR, openR)   // 从合拢 → 展开
      return el.getBoundingClientRect()
    }

    // 落点若在可滚动列里滚出视口 → 快速滚进可视区，并返回滚动后的最终落点（让克隆体飞到那里）
    const revealInScroller = (sc, box) => {
      if (!sc) return box
      const r = sc.getBoundingClientRect(), pad = 6
      let dy = box.bottom + pad > r.bottom ? box.bottom + pad - r.bottom
             : box.top - pad < r.top ? box.top - pad - r.top : 0
      const maxDown = sc.scrollHeight - sc.clientHeight - sc.scrollTop
      dy = dy > 0 ? Math.min(dy, maxDown) : Math.max(dy, -sc.scrollTop)
      if (Math.abs(dy) <= 1) return box
      _animateScroll(sc, dy, 300)
      return { left: box.left, top: box.top - dy, width: box.width, height: box.height }
    }

    // 松手即进入「归位/落位」飞行动画（0.55~0.7s）。飞行途中克隆体仍是 fixed 定位，
    // 若继续顶着抓取时的压顶 z(99999)，飞行路径经过悬浮窗口（文件预览/咕咕聊天，20000+ 那一带）
    // 时会整个盖住窗口，动画结束克隆体一 remove 又突然消失——观感是「窗口被糊一下又露出来」。
    // 松手这一刻起改用低 z：默认只需盖过页面里同层的兄弟卡片（自然堆叠序≈0）；卡片若活在
    // 浮窗/弹层里（如项目编辑卡）则动态探测那个浮窗自己的 z，见 _landingZIndex 注释。
    clone.style.zIndex = String(_landingZIndex(sourceEl))
    // 业务 drop + Vue 重渲染在微任务里已落定；本 rAF 在 paint 前做落点 FLIP，避免闪一下
    requestAnimationFrame(() => {
      // 1) 释放点压着文件夹/面包屑 → 吸入（不依赖异步重渲染）
      //    skipAbsorb（看板）跳过：看板永不吸入文件夹，而此处 elementFromPoint 在 moveProject 把布局改脏后
      //    会强制一次整页重排（trace 里 elementFromPoint 161ms 的大头）——白白吃掉松手那帧。
      if (!opts.skipAbsorb) {
        const under = document.elementFromPoint(dropX, dropY)
        const absorb = opts.resolveAbsorbTarget
          ? (under && opts.resolveAbsorbTarget(under))
          : (under && under.closest && under.closest('.folder-card, .bc-item'))
        if (absorb) { flyTo(absorb.getBoundingClientRect(), true); return }
      }

      // clone2 不再套 .phys-drag-clone/光晕——直接是目标元素此刻真实 DOM 的克隆，从交叉淡变
      // 一开始就长得跟真卡一样（背景/描边/阴影/文件夹颜色渲染全部原样带过来，不用手动猜数值）。
      // flyMorph 结尾把 revealEl 揭示出来时，clone2 早已跟它像素级一致，不会再有「跳一下」的硬切换。
      const _cloneLanding = (el: HTMLElement) => {
        const c = el.cloneNode(true) as HTMLElement
        if (opts.cloneClass) c.classList.add(opts.cloneClass)
        Object.assign(c.style, {
          position: 'fixed', left: '0', top: '0',
          width: clone.style.width, height: clone.style.height,
          margin: '0', boxSizing: 'border-box', zIndex: clone.style.zIndex, pointerEvents: 'none',
          willChange: 'transform', transition: 'none', opacity: '0',
          transform: clone.style.transform,   // 起点与旧克隆重叠
        })
        document.body.appendChild(c)
        return c
      }

      // 2) 卡片落到新位置（换列/重排）
      if (sel) {
        const el = document.querySelector<HTMLElement>(sel)
        if (el && el.isConnected && el !== sourceEl) {
          if (el.offsetWidth > 0) {   // 落点可见 → 占位 FLIP 展开；双克隆同轨迹飞行 + 样式渐变
            animateOpen(el.parentElement, el)   // 它为量 FLIP 会瞬间 display:none 落点卡，故滚动放其后
            // 落点在可滚动列里若滚出视口 → 快速滚进可视区，box 取滚动后的最终落点
            const sc = _scrollParent(el)
            const box = revealInScroller(sc, el.getBoundingClientRect())
            flyMorph(box, el, _cloneLanding(el))
          } else {                    // 落点在折叠分组里不可见（如已完成列折叠的月份）→ 就地缩小淡出
            flyTo({ left: dropX - half.x, top: dropY - half.y, width: rect.width, height: rect.height }, true)
          }
          return
        }
      }

      // 3) 没变化 → 归位（原位若在列里滚出视口，也要快速滚回去）；同样走 flyMorph 交叉淡变，
      // 不用 flyTo 硬切换——克隆体本来就比真卡「更实」（撑对比度用），硬切一帧很容易看出跳变。
      if (container && sourceEl.style.display === 'none') {
        // 已收合 → 先占位 FLIP 重新展开源卡（列恢复溢出），再算滚动容器，否则收合时列不溢出 → 取不到 sc
        const box0 = animateOpen(container, sourceEl)
        const sc = _scrollParent(sourceEl)
        // 锁列期间源卡收合，浏览器可能把 scrollTop 夹小了；展开后还原到拖动前，revealInScroller 再据此滚到原位
        if (sc && _savedScrollTop.has(sc)) {
          sc.scrollTop = _savedScrollTop.get(sc)
          const box = revealInScroller(sc, sourceEl.getBoundingClientRect())
          flyMorph(box, sourceEl, _cloneLanding(sourceEl))
        } else {
          const box = revealInScroller(sc, box0)
          flyMorph(box, sourceEl, _cloneLanding(sourceEl))
        }
      } else {
        // 收合还没来得及发生（极快的拖放）→ 直接归位即可
        sourceEl.style.display = ''
        sourceEl.style.opacity = '0'
        const sc = _scrollParent(sourceEl)
        const box = revealInScroller(sc, sourceEl.getBoundingClientRect())
        flyMorph(box, sourceEl, _cloneLanding(sourceEl))
      }
    })
  }

  _active = { raf: 0, end }
  if (pointer) {
    document.addEventListener('pointermove', onOver)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
  } else {
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', end, true)   // 捕获阶段，先于业务 drop 收尾视觉
    sourceEl.addEventListener('dragend', end)
  }
  _active.raf = requestAnimationFrame(frame)
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
export function startMultiPhysicsDrag(event, sourceEl, count, extras = [], opts: PhysicsDragOpts = {}) {
  if (!sourceEl || _active) return
  _flushPendingCleanup(sourceEl)   // 同 startPhysicsDrag：只打断同一张卡上一趟还没飞完的动画
  for (const ex of extras) { if (ex) _flushPendingCleanup(ex) }
  const pointer = opts.pointer === true
  const pointerId = pointer ? event.pointerId : null
  if (!pointer) { try { event.dataTransfer?.setDragImage(_transparentGhost(), 0, 0) } catch {} }
  if (pointer) { try { document.body.setPointerCapture(pointerId) } catch {} }

  // 上一次拖拽的落地动画要等 transitionend（~420~580ms）才把卡片复位显示，这段窗口期内重新
  // 抓同一批卡会读到 0×0 的 rect、克隆出不可见的卡（同 startPhysicsDrag 的坑，见其注释）。
  // sourceEl 与每个 extras 成员都可能是刚从上一次拖拽落地、还没轮到 finish() 的卡。
  sourceEl.style.display = ''
  sourceEl.style.opacity = ''
  for (const ex of extras) { if (ex) { ex.style.display = ''; ex.style.opacity = '' } }

  const SPRING = opts.spring  ?? 190
  const ZETA   = opts.damping ?? 0.82
  const LIFT   = opts.lift    ?? 1       // 1=不放大
  const SWAY   = opts.sway    ?? 0.25
  const TILT   = opts.tilt    ?? 5
  const GRABY  = opts.grabY   ?? 28

  const rect = sourceEl.getBoundingClientRect()
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
      ` perspective(760px) rotateX(${(TILT * 0.6).toFixed(2)}deg)` +
      ` rotateZ(${cfg.spread.rz.toFixed(2)}deg) scale(${(LIFT * cfg.spread.sc).toFixed(4)})`

    let el
    if (extraEl) {
      // 克隆真实文件卡内容
      el = extraEl.cloneNode(true)
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
      width: rect.width + 'px', height: rect.height + 'px',
      margin: '0', boxSizing: 'border-box', overflow: 'hidden',
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
  const clone = sourceEl.cloneNode(true) as HTMLElement
  clone.classList.add('phys-drag-clone')
  // 移除拖拽/剪切态，保留 .selected 以显示选中边框和覆盖层
  clone.classList.remove('dragging', 'cut')
  clone.querySelectorAll('.sel-checkbox, .fc-hover-actions, .fd-hover-actions').forEach(n => n.remove())
  // opts.cloneClass 补回脱离上下文后丢失的版式（如 ProjectModal mode2 的 pm-clone-expanded）
  if (opts.cloneClass) clone.classList.add(opts.cloneClass)
  Object.assign(clone.style, {
    position: 'fixed', left: '0', top: '0',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0', boxSizing: 'border-box', overflow: 'visible',
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
  let lastT = null
  let foldT = 0           // 0→1: 折叠进度（扇开→紧贴）
  const FOLD_DUR = 0.30   // 秒

  function onOver(e) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (e.clientX || e.clientY) {
      target.x = e.clientX; target.y = e.clientY
      opts.onDragOver?.({ x: e.clientX, y: e.clientY })
    }
  }

  function frame(now) {
    let dt = lastT === null ? 1 / 60 : (now - lastT) / 1000
    lastT = now
    if (dt > 1 / 20) dt = 1 / 20

    // 折叠动画进度（ease-out 二次方）
    foldT = Math.min(1, foldT + dt / FOLD_DUR)
    const fold = 1 - Math.pow(1 - foldT, 2)

    // 弹簧积分
    let rem = dt
    while (rem > 1e-4) {
      const h = Math.min(rem, 1 / 120)
      rem -= h
      const ax = SPRING * (target.x - pos.x) - DAMP * vel.x
      const ay = SPRING * (target.y - pos.y) - DAMP * vel.y
      vel.x += ax * h; vel.y += ay * h
      pos.x += vel.x * h; pos.y += vel.y * h
    }

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

    _active.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!_active) return
    cancelAnimationFrame(_active.raf)
    _active = null
    document.body.classList.remove('phys-dragging')
    if (pointer) {
      document.removeEventListener('pointermove', onOver)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      try { document.body.releasePointerCapture(pointerId) } catch {}
    } else {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', end, true)
      sourceEl.removeEventListener('dragend', end)
    }

    // 影子克隆淡出移除
    for (const { el } of shadows) {
      el.style.transition = 'opacity 0.18s ease'
      el.style.opacity = '0'
      let shadowDone = false
      let unregisterShadow = () => {}
      const removeShadow = () => { if (shadowDone) return; shadowDone = true; unregisterShadow(); el.remove() }
      unregisterShadow = _registerCleanup(sourceEl, removeShadow)
      setTimeout(removeShadow, 220)
    }

    // pointer 模式：落点的业务移动（多选批量移动）由调用方在此执行（原生模式靠各列 @drop 落定）
    if (opts.onDrop) { try { opts.onDrop({ x: target.x, y: target.y }) } catch (err) { console.error('[physicsDrag] onDrop failed', err) } }

    const dropX = target.x, dropY = target.y
    const SLOT = box => `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(1)`

    let done = false, onEnd = null
    const flyTo = (box, shrink) => {
      clone.style.transition = `transform 0.55s ${_SETTLE}, opacity 0.4s ease`
      if (shrink) {
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        clone.style.opacity = '0'
        clone.style.transform =
          `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) perspective(760px) rotateX(0deg) rotateZ(0deg) scale(0.32)`
      } else {
        // 归位：飞回源卡并淡出（源卡始终可见，克隆体直接消失）
        clone.style.transform = SLOT(box)
        clone.style.opacity = '0'
      }
      let unregister = () => {}
      const finish = () => {
        if (done) return
        done = true
        unregister()
        clone.removeEventListener('transitionend', onEnd)
        clone.remove()
      }
      unregister = _registerCleanup(sourceEl, finish)
      onEnd = finish
      clone.addEventListener('transitionend', onEnd)
      setTimeout(finish, 680)
    }

    // 松手即进入归位/落位飞行（见单选 end() 里同名注释 + _landingZIndex）：不再顶着压顶 z，
    // 改按卡片所在的层叠上下文动态取值，避免飞行路径盖住悬浮窗口、也避免被卡片自己所在的浮窗盖住
    clone.style.zIndex = String(_landingZIndex(sourceEl))
    requestAnimationFrame(() => {
      // 吸入文件夹/面包屑
      const under = document.elementFromPoint(dropX, dropY)
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

  _active = { raf: 0, end }
  if (pointer) {
    document.addEventListener('pointermove', onOver)
    document.addEventListener('pointerup', end)
    document.addEventListener('pointercancel', end)
  } else {
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', end, true)
    sourceEl.addEventListener('dragend', end)
  }
  _active.raf = requestAnimationFrame(frame)
}
