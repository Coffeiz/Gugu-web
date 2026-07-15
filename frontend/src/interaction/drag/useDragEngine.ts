/**
 * 拖拽物理效果（项目卡 / 文件卡通用）
 *
 * 原生 HTML5 拖放的 ghost 由浏览器接管，无法做弹簧跟随、占位收合或落点让位。
 * 这里在保留原有拖放逻辑（dragstart/drop 照常）的前提下叠一层视觉物理：
 *   - 拾起：隐藏源卡（克隆体即「本体」跟着指针弹簧跟随、带后仰），源卡占位用 FLIP **动画收合**；
 *   - 落下：飞到实际落点（换列/重排的新槽位），落点容器的其它卡 **FLIP 动画让位**；
 *     文件被收进文件夹/面包屑 → 缩小吸入；没变化 → 占位 FLIP 重新展开、克隆体归位。
 */

import { LandingState } from './animation/landing'
import { dragRegistry } from './core/DragRegistry'
import { integrateSpring } from './core/physics'
import { dispatchDragHandoff } from './interaction/handoff'
import { startThresholdDrag, ThresholdDragOpts } from './interaction/threshold'
import { cloneForDrag } from './visual/clone'
import { resolveLandingZIndex } from './visual/layer'

// 拖拽物理可选项（startPhysicsDrag / startMultiPhysicsDrag 共用）
export interface PhysicsDragOpts {
  pointer?: boolean
  spring?: number
  damping?: number
  lift?: number
  sway?: number
  tilt?: number
  grabY?: number
  // true 时忽略 grabY，让克隆体的竖直中心（不是"顶部往下固定 28px 那一点"）跟着指针走——
  // 看板卡沿用"像从卡片顶部附近拈起一张纸"的手感（grabY 默认 28），无限画布上没有"顶部"这个
  // 参照系，抓哪张卡都应该是卡片中心跟手，不然矮卡片（离 28px 近）看着几乎贴指针、高卡片
  // 又明显吊在指针下方，各类型贴纸手感不一致，见画布贴纸（useCardDrag.ts/ProjectRefCard.vue）
  // 的用法。
  centerGrab?: boolean
  cloneClass?: string
  // velocity 是松手瞬间弹簧积分出来的速度（px/s，屏幕坐标系）+ turn（最近一小段时间速度方向
  // 转过的角度，弧度，见 startPhysicsDrag 里的 velHistory），给需要"甩出去带一点惯性、还想
  // 带上手腕转弯弧度"的调用方用（如画布贴纸，见 useCardDrag.ts）；看板卡/文件拖放这类离散
  // 目标判定用不上，不传第二个参数也完全兼容。
  // size 是克隆体此刻真实的视觉宽高（屏幕像素，来自 rect/half，不是调用方自己存的那份可能
  // 过时的「假定尺寸」）——画布贴纸的落点居中计算依赖它，见 useCardDrag.ts：卡片实际渲染
  // 多高（客户名有没有、是否完成态换了行）跟存储侧记的默认/上次测量值经常对不上，落点算出
  // 来的"卡片中心"就会跟指针实际抓的地方有落差（用户反馈"连线点比卡片中心低""落点偏高"）。
  // 直接把物理模块自己量好的这份精确尺寸传出去，调用方不用再猜。
  onDrop?: (
    pos: { x: number; y: number },
    velocity: { x: number; y: number; turn: number },
    size: { w: number; h: number },
    context?: PhysicsDropContext,
  ) => void
  onDragOver?: (pos: { x: number; y: number }) => void   // pointer 模式：每帧回调当前指针位置，供调用方自己 elementFromPoint 判定/高亮落点
  // 每帧回调克隆体此刻真实的视觉中心（下方 frame() 弹簧积分出来的结果，带阻尼延迟——不是
  // 瞬时跟手的指针位置）+ 此刻真实的视觉宽高（理由同 onDrop 的 size）。给「要跟着克隆体本体
  // 一起走」的视觉用（如画布连线跟着被拖的卡）：若用 onDragOver 的瞬时指针位置，会跑得比带
  // 阻力的克隆体更快更靠前，线跟卡片对不上，也没有克隆体那种「甩不动、有点阻力」的手感——
  // onFollow 直接给同一份弹簧积分结果，天然一致。
  onFollow?: (pos: { x: number; y: number }, size: { w: number; h: number }) => void
  // 源卡此刻的渲染受一层祖先缩放影响（画布相机缩放，见 useMindCanvas.ts 的 camera.scale）——
  // getBoundingClientRect 量出来的尺寸已经是缩放后的，克隆体脱离缩放祖先后单靠这份尺寸撑
  // 外框，内部内容不会跟着等比缩放。传这个值让克隆体退回原始布局尺寸，再由独立 transform
  // 缩放壳补回视觉缩放（不触发文字重排），
  // 不传或为 1 时完全不影响现有调用方（看板卡/文件卡没有缩放祖先，CS 恒为 1）。传函数而不是
  // 静态数字：抓着卡片不放的时候画布还能滚轮继续缩放，每帧都要读一次「当下」的相机缩放，
  // 不能只在抓起那一刻定死一个数——那样边抓边缩放画布，卡片大小会纹丝不动跟不上。
  contentScale?: number | (() => number)
  // 拖拽期间克隆体的层级，不传按站内其它拖拽场景的默认值 99999（压过几乎所有内容）。
  // 画布贴纸想让克隆体飞过侧栏时老实压在侧栏底下（不遮住导航），传一个比侧栏 z-index 低
  // 的值。
  dragZIndex?: number
  skipAbsorb?: boolean
  // 「吸入文件夹/面包屑」缩小消失动画的目标判定：不传则退回默认的 .folder-card,.bc-item 类名匹配
  // （历史行为）。传了就由调用方决定 under 是否算有效吸入目标、返回该元素（给动画取
  // getBoundingClientRect）或 null——避免组件自己另一套判定和调用方 onDrop 里的判定不一致，
  // 出现"数据没移动、动画却演了吸入消失"的画面和实际状态对不上。
  resolveAbsorbTarget?: (under: Element) => Element | null
  /** 吸入目标是否收缩。项目退回抽屉时保留整张卡飞入对应素材位，避免像删掉一样缩没。 */
  absorbShrink?: boolean
  // 吸入抽屉时，业务状态更新会先让画布卡消失、下一帧才把对应素材卡插回列表。这里延迟
  // 解析那张具体卡，不能拿整个抽屉容器当 morph 终点，否则会飞到容器左上角。
  resolveAbsorbLandingTarget?: () => HTMLElement | null
  // resolveAbsorbLandingTarget 的轮询上限；不传退回历史值 300ms。画布卡拖回项目抽屉时，
  // 这张目标卡要等 returnCanvasItemToDrawer 的接口请求真正回来、store 响应式更新后才会
  // 挂载——300ms 只够本地网络，接口稍慢（或后端有排队）时轮询会先超时，退化成用命中的
  // 整个抽屉容器当 morph 终点，白白丢失"精确飞向那张卡"的效果。调用方明确知道自己的接口
  // 延迟量级时应传一个更宽松的值。
  absorbLandingWaitMs?: number
  // 外部来源（例如画布右侧素材抽屉）在松手后才异步创建真正的目标卡片时，用这份 getter
  // 把物理克隆交接给目标 DOM。拿到目标前克隆停在释放位置，拿到后复用原有 flyMorph，
  // 不会出现"源卡飞回去、目标卡另冒出来"的两段式动画。
  resolveLandingTarget?: () => HTMLElement | null
  // 外部目标由接口创建时允许等待的最长时间；不传则不等待，保持既有页面拖拽语义。
  landingTargetWaitMs?: number
  // 外部素材库的源卡拖起后保留原位占位，不参与看板卡的 display:none + FLIP 收合。
  // 调用组件通过 .phys-drag-source-placeholder 自己定义占位外观；物理模块只保证成功、
  // 超时、归位和中途重抓都会把这个状态清干净。
  keepSourcePlaceholder?: boolean
  // 外部落点成功后源组件会被业务列表移除（例如同一项目每张画布只允许摆一份）时，
  // 不再尝试把占位恢复成完整卡片，失败/超时归位仍照常恢复。
  removeSourceOnExternalDrop?: boolean
  // 落地飞行尚未结束时又从可见克隆抓起，会从这份当前屏幕矩形继续下一段物理拖拽。仅由
  // startPhysicsDrag 内部递归使用，普通调用方不需要传。
  initialRect?: { left: number; top: number; width: number; height: number }
  // 落地克隆被重新抓起、真正越过拖拽阈值时通知调用方取消自己的附属动画（画布关系线的
  // landingPositions 属于这类附属状态）；不传时只处理物理克隆本身。
  onRegrabStart?: () => void
  // 由落地 holder 接力发起的下一段拖拽。它的状态判定不能继承前一段落地动画的速度。
  isLandingRegrab?: boolean
  // 飞行 holder 上重新抓取时，本体不在真实命中位置；把 holder 已确认的 hover 显式交给新
  // 克隆，避免它按隐藏本体的 :hover=false 误把控制层做成不可见。
  initialHover?: boolean
  // 外部素材拖入画布后，飞行终点是刚创建的画布卡。若落地前再次抓取，应把手势交给那张
  // 画布卡自己的拖拽逻辑（保留 item 移动/连线更新），不能继续调用外部素材的“新建节点”逻辑。
  delegateLandingRegrab?: boolean
}

export interface PhysicsDropContext {
  pointer: { x: number; y: number }
  pointerVelocity: { x: number; y: number }
  isLandingRegrab: boolean
}

interface Box { left: number; top: number; width: number; height: number }
interface ActiveDrag { raf: number; end: () => void }

let _ghostImg: HTMLCanvasElement | null = null
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

let _active: ActiveDrag | null = null   // 同一时刻只有一个拖拽

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
// 每次 _invertPlay 产生一次 FLIP 重排，就据落地卡的**干净布局落点**更新命中的飞行目标。
// ⚠️ 不能直接用 _invertPlay 传来的 rects：并发拖拽下，这张落地卡（此刻 opacity:0、克隆才是可见
// 本体）自己可能正挂着上一次 FLIP 没跑完的 translate——那份 rect 是「带残留 transform 的中间
// 位置」，不是真正的布局落点。据它重定目标 → 克隆过度移动再由真卡归位（实测：先拖 B、快抓 A、
// 松开 A，B 的克隆过度右移然后归位）。这里对每张落地卡临时把 transform 归零（opacity:0，肉眼
// 无感）量出干净布局落点再还原。CSS transition 天然支持途中改目标：从当前插值位置平滑转向新目标。
let _pendingRetargets = new Map<HTMLElement, (box: any) => void>()
function _retargetLandings(kids: HTMLElement[], _rectsIgnored?: any[]) {
  if (!_pendingRetargets.size) return
  for (const k of kids) {
    const fn = _pendingRetargets.get(k)
    if (!fn) continue
    const savedTf = k.style.transform
    const savedTr = k.style.transition
    k.style.transition = 'none'
    k.style.transform = 'none'
    const b = k.getBoundingClientRect()   // 干净布局落点（transform 已归零）
    k.style.transform = savedTf
    k.style.transition = savedTr
    fn({ left: b.left, top: b.top, width: b.width, height: b.height })
  }
}

function _childCards(container: HTMLElement, exclude: Element | null) {
  return ([...container.children] as HTMLElement[]).filter(c =>
    c.nodeType === 1 && c !== exclude && !c.classList.contains('phys-drag-clone'))
}
const _rects = (els: Element[]) => els.map(e => e.getBoundingClientRect())

// 最近的可纵向滚动祖先（兜底：看板/文件库的已知滚动容器，避免 overflow 检测在解锁瞬间抽风）
function _scrollParent(node: Element | null): HTMLElement | null {
  // 先试已知滚动容器：一次 closest 命中即返回，省掉逐级 getComputedStyle 遍历。
  // drop 时布局已被 moveProject 改脏，每次 getComputedStyle 都会触发一次强制样式/布局重算（trace: get scrollTop 105ms）。
  const known = (node && node.closest && node.closest('.col-body, .files-main')) as HTMLElement | null
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
function _animateScroll(el: HTMLElement, dy: number, dur = 300) {
  const from = el.scrollTop
  const ease = (t: number) => 1 - Math.pow(1 - t, 3)
  let start: number | null = null
  const tick = (now: number) => {
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
// pointer 模式下 :hover 判定本身全程是准的（见上面的注释），但目标本体在克隆飞行期间已是
// opacity:0（仍参与命中测试、:hover 已为真）。因此必须在**隐藏本体的那一刻**就开始压制 hover，
// 不能等克隆落地、揭示本体时才补：那会先把已激活的 hover 拉回静止态，再重新进入 hover，形成闪动。
// 被压住的目标在飞行中不会积累 hover 终态；克隆到位后再揭示它，下一帧才允许正常 hover：
//   ① 卡片本体 transform 已在 -2px；② 悬停操作按钮（重命名/下载/删除）opacity 已在 1。
// 若揭示时只恢复 opacity、各自的过渡又都是激活的，卡片会从 -2px 动画回落到压制态 0（下沉）、
// 按钮会从 1 淡出到 0，随后又双双反向动回来——就是「先下沉再上浮」+「按钮闪好几次」。
// 解法：加压制类（把 hover 的 transform/阴影/底色/按钮 opacity 全钉在非 hover 态）的同时，再加
// 一个「快照」类，用 !important 把卡片**及其所有子元素**的 transition 一并关掉；恢复可见、强制
// 提交这一帧——整张卡（含按钮）直接坐在压制态、零动画；随即摘掉快照类恢复过渡（此刻各属性值
// 未变、不会触发任何过渡）。下一帧摘掉压制类时，卡片上浮 + 按钮淡入 + 阴影渐显作为一次
// 干净的 hover-in 平滑发生。全程不摘 pointer-events、不碰命中测试，:hover 一直实时准确
// （不会有「指针不动就再也不触发」的坑）。CSS 见 global.css .phys-just-revealed / .phys-reveal-snap。
function _revealWithoutStaleHover(el: HTMLElement, pointerMode: boolean, onSettled?: () => void, keepControls = false) {
  el.classList.add('phys-just-revealed')   // 压制：hover 的 transform/阴影/底色/按钮 opacity 全归非 hover 态
  el.classList.add('phys-reveal-snap')     // 快照：本帧关掉卡片+全部子元素的过渡，让上面这步瞬间生效、零动画
  if (keepControls) el.classList.add('phys-reveal-controls')
  el.style.opacity = ''
  // 画布贴纸抓起后会暂时 display:none，哪怕鼠标一直停在原位置，也会先收到 mouseleave。
  // 浏览器在元素重新出现时不保证补发 mouseenter；Vue 维护的连接点 hovering 状态便会比
  // CSS :hover 晚一帧恢复，刚从落地克隆切回本体时圆点闪一下。真实命中仍在卡上时主动补发
  // mouseenter，让组件状态在本次 paint 前与浏览器命中状态重新对齐。
  if (pointerMode && (keepControls || el.matches(':hover'))) {
    el.dispatchEvent(new MouseEvent('mouseenter'))
  }
  void el.offsetWidth                      // 强制提交：整张卡（含按钮）直接坐在压制态，不下沉、按钮不淡出
  el.classList.remove('phys-reveal-snap')  // 恢复过渡：此刻各属性值未变 → 不触发过渡；只为随后解除压制的上浮/淡入铺路
  // 解除压制的延迟：0=落地即进入 hover-in（无停顿）。下沉/闪烁靠上面的快照消掉、与此延迟无关，
  // 故 0ms 下依然不闪，只是没有「保持一会儿再 hover」的停顿，落地即平滑上浮。用 rAF 保证压制态
  // 那一帧先真的画出来，再解除——否则同一 task 内一加一撤，浏览器可能合帧、跳过压制态直接到 hover。
  requestAnimationFrame(() => {
    el.classList.remove('phys-just-revealed')
    // Vue 的 hover prop 在上面的 synthetic mouseenter 后要过一个微任务才会写回；多留一帧
    // 控制层强制可见，确保覆盖层撤掉与本体接手之间没有空档。
    if (keepControls) requestAnimationFrame(() => el.classList.remove('phys-reveal-controls'))
  })
  if (pointerMode) { onSettled?.(); return }
  el.style.pointerEvents = 'none'
  setTimeout(() => {
    el.style.pointerEvents = ''
    onSettled?.()
  }, 160)
}

// 克隆开始落地时，目标本体已在鼠标下也不能激活 hover；这层状态一直保留到
// _revealWithoutStaleHover 在克隆动画结束后解除。与“揭示时才加”的旧做法相比，避免中途积累陈旧 hover。
function _holdHoverUntilReveal(el: HTMLElement) {
  el.classList.add('phys-just-revealed')
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
// FLIP：布局已经变到「现状(toRects)」后，让 kids 先回到 fromRects 再动画到现状
function _invertPlay(kids: HTMLElement[], fromRects: DOMRect[], toRects: DOMRect[], dur = 340) {
  _retargetLandings(kids)   // 自行量干净落点，不吃这里可能被残留 transform 污染的 toRects
  kids.forEach((c: HTMLElement, i: number) => {
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
export function startPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, opts: PhysicsDragOpts = {}) {
  if (!(sourceEl instanceof HTMLElement) || _active) return
  const session = dragRegistry.start(sourceEl)
  session.setPhase('dragging')
  _flushPendingCleanup(sourceEl)   // 只打断「同一张卡」上一趟还没飞完的落地动画，避免重叠成「两张卡」
  // 上一次拖拽的落地动画要等 transitionend（~420~580ms）才把这张卡复位显示；这段窗口期内
  // 若重新抓同一张卡，getBoundingClientRect 会在它还是 display:none 时量出 0×0——克隆体宽高
  // 从一开始就定死是 0，看起来「卡片凭空消失」（_active 只挡真正重叠的拖拽，挡不住这个：
  // 前一次拖拽的 end() 早就把 _active 清空了，落地动画是它结束后才独立跑的）。抓之前先强制
  // 复位，不管源卡此刻处于什么中间态。
  sourceEl.classList.remove('phys-drag-source-placeholder')
  sourceEl.style.display = ''
  sourceEl.style.opacity = ''
  const pointer = opts.pointer === true
  const pointerId = pointer ? (event as PointerEvent).pointerId : null
  if (!pointer) { try { (event as DragEvent).dataTransfer?.setDragImage(_transparentGhost(), 0, 0) } catch {} }

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
  const container = sourceEl.parentElement

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
  const clone = cloneForDrag(sourceEl, { addClasses: ['phys-drag-clone'] })
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
  if (pointer) { try { document.body.setPointerCapture(pointerId!) } catch {} }

  // 拖拽期间锁住看板列的滚动：挡掉浏览器原生拖拽的「边缘自动滚动」——否则列在拖动时就被原生滚到底，
  // 落点时已无可滚（dy≈0），我们的受控平滑滚动跑不起来，看着就是「瞬间到底部」。列用的是 3px overlay
  // 滚动条，overflow:hidden 不会引起布局位移。结束时在 end() 还原。
  const _lockedScrollers = [...document.querySelectorAll<HTMLElement>('.col-body')]
  const _savedScrollTop = new Map()
  for (const s of _lockedScrollers) { _savedScrollTop.set(s, s.scrollTop); s.style.overflowY = 'hidden' }

  // 外部素材抽屉保留同尺寸的低透明占位，列表不跳动；普通卡片仍按原逻辑收合让位。
  // 同步 display:none 会让浏览器取消原生拖拽 → 必须下一帧再真正移出布局并做 FLIP。
  if (opts.keepSourcePlaceholder) {
    // 这张卡刚才如果还在飞行中途被抓（比如落地进抽屉的途中重新抓起），上面的
    // _flushPendingCleanup(sourceEl) 会先跑上一趟飞行的 forceCleanup，那里面调用
    // _revealWithoutStaleHover 会把本体的 opacity 强制复位成可见——而这里摘掉占位态、
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
      if (!_active || !session.isCurrent() || !sourceEl.isConnected) return
      const kids = _childCards(container, sourceEl)
      const open = _rects(kids)
      sourceEl.style.display = 'none'
      const closed = _rects(kids)
      _invertPlay(kids, open, closed)
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
    _active!.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!_active || !session.isCurrent()) return
    session.setPhase('landing')
    cancelAnimationFrame(_active.raf)
    _active = null
    document.body.classList.remove('phys-dragging')            // 恢复 backdrop-filter（落点 elementFromPoint 之前）
    for (const s of _lockedScrollers) s.style.overflowY = ''   // 解锁列滚动，下面才能受控平滑滚到落点
    if (pointer) {
      document.removeEventListener('pointermove', onOver)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      try { document.body.releasePointerCapture(pointerId!) } catch {}
    } else {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', end, true)
      sourceEl.removeEventListener('dragend', end)
    }

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
    // _revealWithoutStaleHover 用：那个函数自己会在"先压住 hover 判定、再放开 opacity"
    // 这个正确顺序里把 opacity 复位。如果这里也顺手把 opacity 一起复位了，opacity 会在
    // 压制类还没加上之前就变化，且现在这个属性又挂了 CSS transition（渐变淡出那次改的），
    // 于是这段揭示会在没有压制的窗口期里播一段"正常揭示"过渡——鼠标压在原地时 hover 判定
    // 没被按住，卡片会立刻弹起来，等于绕开了 _revealWithoutStaleHover 本该挡住的那层保护。
    const restoreSourcePlaceholderStyle = () => {
      if (!opts.keepSourcePlaceholder) return
      sourceEl.classList.remove('phys-drag-source-placeholder')
      sourceEl.style.display = ''
    }
    // 完整版：摘样式 + 复位 opacity，给没有配套 _revealWithoutStaleHover（同一个元素）的
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
        _holdHoverUntilReveal(revealEl)
        revealEl.style.opacity = '0'
      }
      holder.style.transition = `transform 0.55s ${_SETTLE}, opacity 0.4s ease`
      if (shrink) {
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        holder.style.opacity = '0'
        holder.style.transform =
          `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) scale(0.32)`
      } else {
        const sx = (box.width / dropW).toFixed(4)
        const sy = (box.height / dropH).toFixed(4)
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        holder.style.transform = `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) scale(${sx}, ${sy})`
      }
      let unregister = () => {}
      const finish = () => {
        if (landing.isDone()) return
        landing.finish()
        unregister()
        holder.removeEventListener('transitionend', onEnd)
        holder.remove()
        // 先摘占位 class 再揭示：同 flyMorph 里 finish()/forceCleanup 的道理，避免揭示瞬间
        // 先闪一下虚线描边、再过渡回实线的中间态被看见。
        restoreSourcePlaceholder()
        if (revealEl) _revealWithoutStaleHover(revealEl, pointer)
        dragRegistry.finish(sourceEl, session)
      }
      unregister = _registerCleanup(sourceEl, finish)
      onEnd = finish
      holder.addEventListener('transitionend', onEnd)
      setTimeout(finish, 680)
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
    ) => {
      // box 用 let：飞行途中可能被 _retargetLandings 改指到新位置（见其注释），finish() 收尾时
      // 要读的是「最新」这份，不是刚进来那一刻的静态快照。
      let box = initialBox
      // 唯一的连接点覆盖层是静态 DOM，动画期间根据真实鼠标命中更新可见性。
      // 落地内容克隆没有连接点，因此不会再发生两张卡片各画一颗点、彼此遮住的问题。
      let landingHovered = false
      const syncConnectionOverlayHover = (hovering: boolean) => {
        landingHovered = hovering
        connectionDotOverlay?.classList.toggle('hovering', revealElConnectable && hovering)
        if (cardActionOverlay) cardActionOverlay.style.opacity = hovering ? '1' : '0'
      }
      // holder 为支持“飞行中直接再抓”而在落地阶段开启了 pointer-events；因此命中它不再会
      // 穿透到底下的 revealEl。两者都是同一张视觉卡，hover 覆盖层必须一视同仁，否则松手
      // 一刻会误判离开、先把连接点/操作区淡掉，等本体揭示后才又出现。
      const isOverLandingCard = (x: number, y: number) => {
        const r = holder.getBoundingClientRect()
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      }
      const onLandingPointerMove = (event: PointerEvent) => {
        syncConnectionOverlayHover(isOverLandingCard(event.clientX, event.clientY))
      }
      // 落地飞行里的 holder 原先永远 pointer-events:none：用户眼前明明有一张卡，却只能去
      // 最终本体的隐形位置再抓，违背直接操作。飞行阶段让 holder 临时吃 pointerdown；仍然沿用
      // 普通卡片的 5px 阈值，点击不会误开一次新拖拽。真正起拖前先取消调用方附属的落地动画，
      // 再让 startPhysicsDrag 自己 flush 掉这一趟克隆，从 holder 当前屏幕矩形无缝续上。
      let cancelLandingRegrab: (() => void) | null = null
      const onLandingPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || cancelLandingRegrab) return
        event.preventDefault()
        event.stopPropagation()
        cancelLandingRegrab = startThresholdDrag(event, {
          getCard: () => revealEl,
          onDragStart: (moveEvent) => {
            cancelLandingRegrab = null
            // 阈值还没跨过时落地动画可能已经自然结束，holder 被移除后 rect 会变成 0,0；
            // 这份手势本该由收尾时取消，双保险在这里再拦一次，绝不能从左上角续接。
            if (landing.isDone() || !holder.isConnected) return
            // 阈值内卡片仍在继续飞，起点要在真正接力这一刻再量，不能沿用按下那一帧的旧框。
            // 落地画面实际由 clone2 绘制；holder 仍保留的是抓起来源的几何。普通画布卡两者
            // 往往恰好等大，抽屉项目却会经历“抽屉实体尺寸 → 画布缩放尺寸”，取 holder 会把
            // 下一段拖拽从另一张卡的位置起算，抓起瞬间便跳到鼠标。优先量可见 clone2，异常
            // 情况才退回 holder，保证所有落地交接都从用户眼前这张卡续上。
            const clone2Rect = clone2.getBoundingClientRect()
            const visualRect = clone2Rect.width > 0 && clone2Rect.height > 0
              ? clone2Rect
              : holder.getBoundingClientRect()
            opts.onRegrabStart?.()
            // 转手只在落点是「另一个真实本体」（比如画布上刚接手的 ProjectRefCard，自己
            // 挂了 physics-landing-regrab 监听）时才有意义；revealEl === sourceEl 说明这趟
            // 飞行是"飞回自己原位"（比如抽屉卡往回放），根本没有别的组件会接这个事件——
            // dispatchEvent 会静默扔进没人接的地方，defaultPrevented 恒为 false，代码会误判
            // "转手失败"落进下面的默认分支，把 keepSourcePlaceholder 强制摁成 false（那段
            // 注释的前提"落地卡已经是真实本体"在这里不成立，目标其实还是同一张抽屉卡自己），
            // 复现的就是 display:none 元素测量全 0、卡片消失那个坑。干脆不发这次转手事件。
            if (opts.delegateLandingRegrab && revealEl !== sourceEl) {
              const handedOff = dispatchDragHandoff(revealEl, moveEvent, visualRect)
              // 画布卡已接过同一份物理手势；旧 holder 的落地收尾会在新拖拽里被清理，
              // 不能再走下面的默认递归，否则同一次移动会起两张克隆。
              if (handedOff) return
              // 转手没人接（listener 没挂上/别的边界情况）——下面的默认分支会用这次闭包里
              // 捕获的 opts（抽屉卡那次拖拽的 resolveAbsorbTarget/resolveLandingTarget/
              // removeSourceOnExternalDrop 等）去驱动 revealEl（画布卡）的新一段拖拽，两者
              // 语义完全对不上：revealEl 早已是画布上的真实节点，该用它自己的 useCardDrag
              // 配置才对。误用旧配置会导致克隆体从一个跟当前手势无关的坐标起飞，表现为
              // "卡片从视口左上角/上方飞入"。转手失败不如什么都不做，让这次落地动画自然播完，
              // 用户落地后再拖一次即可（那条路径本来就正常）。
              return
            }
            startPhysicsDrag(moveEvent, revealEl, {
              ...opts,
              // 外部素材源才需要保留占位；落地卡已经是画布/看板里的真实本体，接力抓起时
              // 必须回到正常的隐藏 + FLIP 语义，不能在画布上留下第二张半透明卡。但
              // revealEl === sourceEl（飞回自己原位被重新抓起）时目标还是原来那张源卡，
              // 该按 opts 原本的 keepSourcePlaceholder 继续，不能一刀切摁成 false。
              keepSourcePlaceholder: revealEl === sourceEl ? opts.keepSourcePlaceholder : false,
              initialRect: visualRect,
              initialHover: true,
              isLandingRegrab: true,
            })
          },
        }) ?? null
      }
      if (pointer) {
        holder.style.pointerEvents = 'auto'
        holder.addEventListener('pointerdown', onLandingPointerDown)
      }
      // 先让 holder 参与命中再做首帧判定：若仍是 pointer-events:none，elementFromPoint 会
      // 穿透飞行卡片，原地松手又没有新的 pointermove 时覆盖层就会一直维持误判的淡出状态。
      // target 记录的是最近一次真实指针坐标（不是带弹簧延迟的 cloneCenter），正好可用于
      // 落地第一帧的命中判断。
      syncConnectionOverlayHover(isOverLandingCard(target.x, target.y))
      if (pointer) document.addEventListener('pointermove', onLandingPointerMove)
      // overlay 挂在 holder 里；让 holder 比落地内容克隆高一层，圆点始终压在纸面/玻璃面之上。
      if (connectionDotOverlay) holder.style.zIndex = String((Number(holder.style.zIndex) || 0) + 1)
      // 克隆体是按源卡(旧)尺寸渲染的；缩放到落点卡尺寸，并让缩放后中心对齐落点中心。
      // 抽成纯函数：给任意一个「目标框」算出对应 transform 字符串——retarget 冻结当前位置时也复用
      // 它（用同一套函数式表示，见下），避免跟 getComputedStyle 的 matrix3d 混用导致跨表示插值。
      const tfFor = (b: { left: number; top: number; width: number; height: number }) => {
        const sx = (b.width  / dropW).toFixed(4)
        const sy = (b.height / dropH).toFixed(4)
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2
        return `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) scale(${sx}, ${sy})`
      }
      const applyTransform = () => {
        const tf = tfFor(box)
        holder.style.transform = tf
        clone2.style.transform = tf
      }

      // 落地飞行这 0.55s 期间画布相机（缩放和/或平移）可能还在变——滚轮缩放跟松手同时发生，
      // 或者松手那一刻正拖着画布平移。画布的变化和这段飞行动画本该是两件独立的事：飞行是一段
      // 固定的、跟画布无关的位移+形变（从抓起时的位置飞到落点该有的位置/形状），画布这段时间
      // 内继续变，不该去重新定这段飞行的目标——试过"每帧重新量本体真实位置、改 CSS transition
      // 的目标"，画布连续平移时每一帧都在从当前插值位置重新起跑一段完整的 0.55s 缓出曲线，
      // 跑不完就被下一帧打断，连续打断叠加起来就是"追着走、像带了惯性/阻力"（用户反馈"绝对
      // 位置移动好像有惯性，不是完全跟随画布"）——本体（revealEl）自己是零延迟跟着相机变换走
      // 的，克隆不该比它多一层弹性。
      // 解法：加一层不带 transition 的外层容器 camGlue，专门瞬时承接"画布相对落地那一刻挪动/
      // 缩放了多少"；holder/holder2 挂在它里面（position:fixed 元素若祖先带 transform 会改用
      // 该祖先的盒子当定位基准，这是标准 CSS 行为），自己那段飞行的 transform 完全不用管画布，
      // 仍按抓起→落点这段固定的位移/形变缓出。camOrigin 是本体落地那一刻的真实框；每帧重新
      // 量本体现在的真实框，两者一比就是画布纯粹的位移量+缩放比例，transform-origin 钉在
      // camOrigin 上使 scale 的缩放中心正好对上，瞬时套到 camGlue 身上——画布怎么动克隆就怎么
      // 跟，跟本体自己的观感一致，同时飞行动画本身的缓出曲线完全不受干扰。
      // clone/clone2 都在 camGlue 的子孙树中，camGlue 的 scale 已统一带动内容；各自的
      // scaleShell 只需保留落地时的缩放基准，不必每帧重复更新。
      // ⚠️ 这层容器必须在下面「提交初始态→改 transform 触发过渡」这套 FLIP 手法之前就接好线：
      // 把 holder/clone2 挪进一个新祖先，等它们已经带着待生效的过渡在途中再挪，实测浏览器会
      // 把这次 DOM 挪动当成一次全新布局上下文，直接判定这趟过渡不成立、瞬间跳到终值（松手瞬间
      // 的弹出动画整个消失，变成"直接瞬移到落点"）。先接好 camGlue 这层壳，再走 FLIP 那一套，
      // 两件事互不干扰。
      let camGlue: HTMLElement | null = null
      if (trackCanvasCamera && typeof opts.contentScale === 'function') {
        camGlue = document.createElement('div')
        Object.assign(camGlue.style, {
          position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
          transition: 'none', transform: 'translate3d(0,0,0)', pointerEvents: 'none',
          // camGlue 自己带 transform，会建立新的层叠上下文——holder 原来的 z-index（拿来跟
          // 侧栏之类的页面元素比高低）从此只在 camGlue 内部有效，camGlue 本身对外是 z-index:
          // auto，会直接落到任何带显式 z-index 的页面元素后面，之前"克隆压在侧栏下面"那套
          // 设定就失效了。这里把 holder 算好的 z-index 原样搬到 camGlue 身上，让它对外的层叠
          // 位置跟没加这层容器之前一致。
          zIndex: holder.style.zIndex,
        })
        document.body.appendChild(camGlue)
        camGlue.appendChild(holder)
        camGlue.appendChild(clone2)
        const camOrigin = initialBox
        camGlue.style.transformOrigin = `${camOrigin.left}px ${camOrigin.top}px`
        // 没有缩放/平移发生时 revealEl 的真实框不会变——之前不管有没有变化每帧都强制读一次
        // getBoundingClientRect()（会强制同步布局）、每帧都重写一次 transform，绝大多数落地
        // 动画其实全程画布纹丝不动，这份每帧开销纯属浪费，还可能在克隆↔本体交叉淡变这半秒
        // 里挤掉渲染预算，掉一两帧就会看到那半秒该丝滑的透明度过渡卡一下、露出瞬间的"半透明
        // 一闪"（用户反馈"松手时会半透明一下，没有丝滑渐变到本体"）。量出来的框没变就跳过
        // 这次写入，真发生画布变化时才动。
        let lastRectKey = ''
        const trackCamera = () => {
          if (landing.isDone() || !session.isCurrent()) return
          const r = revealEl.getBoundingClientRect()
          // 乐观临时卡在服务端真实 id 回写的一瞬间，Vue 可能经历一帧内部重排；此时旧落点
          // 节点会短暂量成 0×0。它不是画布真的缩放到了 0，若照常参与比例计算会把 camGlue
          // 整层写成 scale(0)，飞行克隆中途消失、只剩真实卡像是瞬移到位。无效几何只跳过
          // 本帧，保留上一帧相机变换，等真实节点恢复有效尺寸后自然继续跟随。
          if (!revealEl.isConnected || r.width < 1 || r.height < 1) {
            requestAnimationFrame(trackCamera)
            return
          }
          const rectKey = `${r.left.toFixed(2)}|${r.top.toFixed(2)}|${r.width.toFixed(2)}`
          if (rectKey !== lastRectKey) {
            lastRectKey = rectKey
            const scaleRatio = camOrigin.width > 0.01 ? r.width / camOrigin.width : 1
            camGlue!.style.transform =
              `translate3d(${(r.left - camOrigin.left).toFixed(2)}px, ${(r.top - camOrigin.top).toFixed(2)}px, 0) scale(${scaleRatio.toFixed(4)})`
          }
          requestAnimationFrame(trackCamera)
        }
        requestAnimationFrame(trackCamera)
      }

      clone2.getBoundingClientRect()   // 提交初始态（与 holder 重叠、opacity 0），下面才会从此处动画
      // 交叉淡变的 opacity 不能打在 holder/clone2 这层外壳上，得打在它们各自里面真正的内容
      // 元素（clone / c2Inner）上——玻璃质感的贴纸（活动贴纸 EntitySticker.vue 的 .glass-card，
      // 项目/文件卡的毛玻璃拖拽态）自带 backdrop-filter，而 CSS 规范里「半透明的祖先」会让
      // 后代的 backdrop-filter 形成一个隔离的合成组，只能采样组内的东西，采不到真实页面背景——
      // 这段淡变期间模糊看着发闷发灰、跟静止态清晰的玻璃质感不一样，一等克隆被摘掉、本体
      // （opacity 全程是 1，不受影响）露出来就"猛地"变清晰，正是用户反馈的「先半透明一下，
      // 再突然变成本体」。这正是 BaseModal 玻璃进场动画踩过、后来改成「全程不碰 opacity，只
      // 动 backdrop-filter 本身」绕开的同一类坑（见 global.css 的 .bm-enter-active 那段注释）——
      // 这里没法照抄那套（我们要的恰恰是内容层面的交叉淡变，不是模糊半径渐变），但道理相通：
      // 只要让 opacity 和 backdrop-filter 落在同一个元素上（而不是隔着一层不透明的祖先），
      // backdrop-filter 采样的仍是它自己在页面里的真实位置背景，不会被祖先的半透明状态污染。
      // holder/clone2 外壳永远保持 opacity:1，只负责 transform 那部分缓出；真正的淡入淡出
      // 挪到 clone（活动拖拽阶段的克隆内容）和 c2Inner（_cloneLanding 里落地克隆的内容，见
      // 该函数）身上。
      const cloneInner = clone
      // scaleShell 加入后 clone2.firstElementChild 已经不是实际卡片。opacity 必须落在真实卡片上：
      // 写在缩放壳会成为 backdrop-filter 的半透明祖先，文件/活动卡落地时便会发灰再突然变清晰。
      const c2Inner = clone2.querySelector<HTMLElement>('.phys-landing-content')
      const trans = `transform 0.55s ${_SETTLE}`
      const fadeTrans = 'opacity 0.42s ease'
      // 回到抽屉时主克隆会隐藏，只剩落地副本承担画面。把抓取态的强阴影先交给它，
      // 再和位移同步收进抽屉静止态，不能直接从主克隆切成普通卡阴影。
      const dragShadow = hidePrimaryVisual ? getComputedStyle(cloneInner).boxShadow : ''
      const landingShadow = hidePrimaryVisual && c2Inner ? getComputedStyle(c2Inner).boxShadow : ''
      cloneInner.style.transition = fadeTrans
      if (c2Inner) c2Inner.style.transition = fadeTrans
      // clone2（_cloneLanding 里的 holder2）创建时是按「先不可见、被自己的 opacity 淡入」的
      // 老设计写的 inline opacity:'0'——现在淡入淡出已经挪到内容层（c2Inner），这层外壳必须
      // 显式扳回 1，否则它自己还停在创建时那份 0，不管 c2Inner 淡到多亮，乘出来的可见度
      // 永远是 0（外壳 0 × 内容任意值 = 0）——落地全程只看得到 holder 那份在变透明消失，
      // 看着就是「先完全透明、克隆一撤本体才突然冒出来」，没有真正淡入的一半。
      clone2.style.opacity = '1'
      cloneInner.style.opacity = '0'
      if (c2Inner) c2Inner.style.opacity = '1'
      // 抽屉来源直接回到自身时，落地副本 clone2 已经是完全相同的正确外观；抓取副本
      // holder 的坐标仍带着画布缩放期间的壳，若同时可见会留下从抽屉左上角掠过的半透明残影。
      // 它仍保留为透明命中层，确保飞行中可重新抓取，只是不再承担任何可见内容。
      if (hidePrimaryVisual) {
        holder.style.opacity = '0'
        if (c2Inner) {
          c2Inner.style.transition = 'none'
          c2Inner.style.boxShadow = dragShadow
        }
        // 提交强阴影作为下一帧过渡的起点；否则浏览器会把两次写入合并，仍然直接跳到静止阴影。
        void clone2.offsetWidth
      }

      // 飞行途中容器发生 FLIP 重排（另一张卡被抓起/放下）→ 落点跟着挪位，把目标改过去。
      // 直接在飞行中途改 transform 目标，浏览器会当「打断」处理：新一段插值默认按当前速度
      // 顺势打断续接，而不是重新从静止起步走一遍完整缓出曲线——两段拼起来速度不连续，
      // 观感比原本单段飞行更接近匀速，缓出的「快进慢收」感被削弱。
      // 做法：读出克隆体此刻真实渲染的位置 → 关过渡、把这个位置钉死成当前态 → 重新打开过渡、
      // 指向新目标，让这一段重新从「静止的当前位置」完整跑一遍同一条缓出曲线。
      // 关键：冻结用的当前态必须跟目标态是**同一种 transform 表示**（都走 tfFor 的函数式
      // translate3d+perspective+scale）。之前冻结读的是 getComputedStyle().transform——因为带
      // perspective()，它返回的是 matrix3d(...)，再过渡到函数式目标属于「跨表示插值」，浏览器
      // 各自分解成矩阵再插，路径不稳 → 并发拖拽（先拖 B 再拖 A、松开 A 让 B 归位）时 B 的回退
      // 会瞬移/曲线不一致。改用 getBoundingClientRect 拿当前真实框、再用 tfFor 重建同款函数式
      // 表示，freeze 与 target 同构，插值干净，跟普通 FLIP 让位一致。
      const retarget = (newBox: Box) => {
        if (landing.isDone()) return
        const r = clone2.getBoundingClientRect()   // 当前真实可见框（含插值中间态；landing 无旋转，rect 即真位置）
        box = newBox
        // 冻结当前位置：关过渡 + 同款函数式表示（tfFor，不用 getComputedStyle 的 matrix3d，避免跨表示插值）。
        const frozen = tfFor({ left: r.left, top: r.top, width: r.width, height: r.height })
        holder.style.transition = 'none'
        clone2.style.transition = 'none'
        holder.style.transform = frozen
        clone2.style.transform = frozen
        // 关键：下一帧再恢复过渡 + 指向新目标，跟 _invertPlay 的 FLIP 完全同一套跨帧触发方式。
        // 之前用同步 `void offsetWidth` 提交冻结态、同一 tick 里就恢复过渡+改目标——某些情况下浏览器
        // 不把它当成过渡基线，过渡不 fire → 直接瞬移到目标（这就是并发拖拽时 B 回退「瞬移一下」的真凶）。
        // rAF 跨过一个真实帧边界，保证冻结态先画出来、成为过渡起点，随后到目标是一段完整缓出。
        requestAnimationFrame(() => {
          if (landing.isDone() || !session.isCurrent()) return
          holder.style.transition = trans
          clone2.style.transition = trans
          applyTransform()
          armFinishTimer()
        })
      }
      _pendingRetargets.set(revealEl, retarget)

      let unregister = () => {}
      let finishTimer: ReturnType<typeof setTimeout> | null = null
      const armFinishTimer = () => {
        if (finishTimer) clearTimeout(finishTimer)
        // 每次改落点都会重新跑一段 0.55s 的 transform 缓出；兜底计时也必须从这次改向重新算，
        // 否则前一次落地的计时会在新一段动画半路把克隆撤掉，真实卡直接露在终点而瞬移。
        finishTimer = setTimeout(finish, 700)
      }
      const startSettle = () => {
        if (landing.isDone()) return
        holder.style.transition = trans
        clone2.style.transition = trans
        if (hidePrimaryVisual && c2Inner) {
          c2Inner.style.transition = `box-shadow 0.55s ${_SETTLE}`
          c2Inner.style.boxShadow = landingShadow
        }
        applyTransform()
      }
      const finish = () => {
        if (landing.isDone()) return
        landing.finish()
        if (finishTimer) clearTimeout(finishTimer)
        if (pointer) document.removeEventListener('pointermove', onLandingPointerMove)
        cancelLandingRegrab?.()
        cancelLandingRegrab = null
        holder.removeEventListener('pointerdown', onLandingPointerDown)
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
          holder.remove(); clone2.remove(); camGlue?.remove()
          // onReveal（比如 restoreSourcePlaceholder）要先于揭示执行：它会摘掉占位态的
          // class（虚线描边），如果等 _revealWithoutStaleHover 先把本体变回可见，摘 class
          // 那一刻本体已经看得见，class 一摘、border-color 的过渡就会从「可见的虚线」平滑
          // 转场到「实线」，观感是刚落地那一下先闪一次虚线描边再变回正常。先摘 class 再揭示，
          // 揭示出来的就已经是最终样子，不会有这个中间态被看见。
          onReveal?.()
          _revealWithoutStaleHover(revealEl, pointer, undefined, landingHovered)
          dragRegistry.finish(sourceEl, session)
        })
      }
      // 被同一张卡的新拖拽强制打断时用（按 revealEl 记账，见 _registerCleanup——只有再次抓的
      // 正是这张卡才会触发）：摘掉两张克隆、同步（非 rAF 延迟）揭示 revealEl，紧接着就被新拖拽
      // 自己的隐藏覆盖掉，全程同步无绘制帧插入，不会闪一下。不做 finish() 里那套「钉死」精修——
      // 反正马上就要整个移除，没必要为一个不会被看到的最终帧计算像素级样式。
      const forceCleanup = () => {
        if (landing.isDone()) return
        landing.cancel()
        if (finishTimer) clearTimeout(finishTimer)
        if (pointer) document.removeEventListener('pointermove', onLandingPointerMove)
        cancelLandingRegrab?.()
        cancelLandingRegrab = null
        holder.removeEventListener('pointerdown', onLandingPointerDown)
        if (_pendingRetargets.get(revealEl) === retarget) _pendingRetargets.delete(revealEl)
        clone2.removeEventListener('transitionend', onEnd)
        holder.remove(); clone2.remove(); camGlue?.remove()
        // 顺序同上面 finish() 里的说明：先摘占位 class 再揭示，避免刚落地那一下先闪出
        // 虚线描边、再过渡回实线的中间态被看见。
        // onReveal（比如 restoreSourcePlaceholderStyle）会摘掉 phys-drag-source-placeholder，
        // 这一步本身没有过渡保护——.drawer-project-card 的 border-color 挂着 .25s 过渡，
        // 摘除瞬间会往「实线」方向起播一小段，如果这次 forceCleanup 是因为同一张卡被立刻
        // 重新抓起（见 startPhysicsDrag 顶部那次 snap 处理），新一段拖拽会把这个 class
        // 马上加回来，两次切换中间那一下没被保护住的过渡就会被看见，表现为"虚线描边闪一下
        // 消失"。用 phys-reveal-snap 把 onReveal 摘 class 和 _revealWithoutStaleHover 复位
        // opacity 这两步一起框进同一个瞬时窗口，不留过渡缝隙。
        revealEl.classList.add('phys-reveal-snap')
        onReveal?.()
        void revealEl.offsetWidth
        revealEl.classList.remove('phys-reveal-snap')
        _revealWithoutStaleHover(revealEl, pointer, undefined, landingHovered)
        dragRegistry.finish(sourceEl, session)
      }
      unregister = _registerCleanup(revealEl, forceCleanup)
      // clone2 的 opacity 只用来交叉淡变，420ms 就会结束；不能把它当落地完成，
      // 否则目标中途被重定时 transform 还没走完就会提前揭示真实卡。
      onEnd = (e) => { if (e.target === clone2 && e.propertyName === 'transform') finish() }
      clone2.addEventListener('transitionend', onEnd)
      // clone2 是刚插入 DOM 的新节点。仅靠同步的 getBoundingClientRect() 提交起点，在抽屉
      // 临时卡这类「挂载后立即落点」的路径上仍可能被浏览器合并为终态，视觉上就像瞬移。
      // 留出一个真实绘制帧：第一帧只画两张克隆重叠的起点，第二帧才开启 transform 过渡。
      // 这样所有走双克隆落地的卡片都使用同一份可靠的 FLIP 时序。
      requestAnimationFrame(() => {
        if (landing.isDone() || !session.isCurrent()) return
        startSettle()
        armFinishTimer()
      })
    }

    // 占位重新展开：FLIP 邻居从「合拢」动到「展开」。el 当前可能已收合(home)或已展开(落点新卡)，
    // 两种都要先拿到 closed 和 open 两套位置
    const animateOpen = (cont: HTMLElement, el: HTMLElement) => {
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
      _holdHoverUntilReveal(el)
      el.style.opacity = '0'              // 落定前隐藏且压住 hover，克隆体落到位再露出
      _invertPlay(sibs, closedR, openR)   // 从合拢 → 展开
      return el.getBoundingClientRect()
    }

    // 落点若在可滚动列里滚出视口 → 快速滚进可视区，并返回滚动后的最终落点（让克隆体飞到那里）
    const revealInScroller = (sc: HTMLElement | null, box: DOMRect): Box => {
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
        const holder2 = document.createElement('div')
        Object.assign(holder2.style, {
          position: 'fixed', left: '0', top: '0',
          width: dropW + 'px', height: dropH + 'px',
          margin: '0', boxSizing: 'border-box', zIndex: holder.style.zIndex, pointerEvents: 'none',
          willChange: 'transform', transition: 'none', opacity: '0',
          transform: holder.style.transform,   // 起点与旧克隆重叠
        })
        const c = cloneForDrag(el)
        if (opts.cloneClass) c.classList.add(opts.cloneClass)
        c.classList.add('phys-landing-content')
        // el 已作为真实落点被 .phys-drag-source 隐藏；cloneNode 会把这个类一并带来，
        // 其 opacity:0 !important 会让克隆 2 整段飞行不可见，收尾时真实卡才突然出现。
        // phys-drag-source-placeholder 同理要摘：el 自己这份占位 class 故意留到揭示那一刻
        // 才摘掉（虚线描边全程不提前变样，见 landOnAbsorbTarget 的注释），但克隆 2 飞行时
        // 展示的应该始终是"真实卡片长什么样"，不能继承这份占位态，否则飞进来的是个空框。
        c.classList.remove('phys-drag-source', 'phys-reveal-controls', 'phys-drag-source-placeholder')
        c.querySelectorAll('.card-conn-dots').forEach(dot => dot.remove())
        // 操作区由 holder 内唯一的 cardActionOverlay 承担可见性；这里留隐藏副本维持标题行布局。
        c.querySelectorAll<HTMLElement>('.card-actions, .nc-actions').forEach(action => { action.style.visibility = 'hidden' })
        const landingScaleShell = document.createElement('div')
        Object.assign(landingScaleShell.style, {
          position: 'absolute', left: '0', top: '0', width: cloneW + 'px', height: cloneH + 'px',
          transformOrigin: '0 0', transform: `scale(${lastCS})`, pointerEvents: 'none',
        })
        // opacity 也要清：调用这里的几处分支都会先把 el/sourceEl 自己的 opacity 摁成 0 压住
        // 陈旧 hover（见 animateOpen/末尾归位分支），cloneNode(true) 原样带走了这份内联
        // opacity:0——c 是给 holder2 当内容用的，若不清掉，holder2 自己的 opacity 动画
        // （0→0.97）跟 c 身上焊死的 0 相乘，怎么淡入都还是 0，看着就是"松手那一下克隆整个
        // 消失了"。跟 left/top 一样，clone2 的可见性该完全交给外层 holder2 决定。
        Object.assign(c.style, {
          left: '', top: '', right: '', bottom: '', opacity: '',
          zIndex: '', width: cloneW + 'px',
        })
        landingScaleShell.appendChild(c)
        holder2.appendChild(landingScaleShell)
        document.body.appendChild(holder2)
        return holder2
      }

      if (absorbTarget) {
        // 画布卡默认在工具栏/抽屉下方；确认命中抽屉后才抬到其上方，交给 clone2
        // 播放完整的飞入动画。未命中时保持默认层级，卡片自然落在抽屉层下面。
        if (sourceEl.closest('.mind-canvas') || absorbTarget.closest('[data-project-drawer-dropzone]')) {
          holder.style.zIndex = '31'
        }
        if (opts.absorbShrink ?? true) {
          // 文件/文件夹拖进普通文件夹或面包屑仍是原有的单克隆缩小吸入；目标只是一个
          // 容器入口，不是会被克隆交接的卡片，不能先把它隐藏成 opacity:0。
          flyTo(absorbTarget.getBoundingClientRect(), true)
        } else {
          const deadline = performance.now() + (opts.absorbLandingWaitMs ?? 300)
          const landOnAbsorbTarget = () => {
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
            const box = revealInScroller(_scrollParent(targetEl), targetEl.getBoundingClientRect())
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
            _holdHoverUntilReveal(targetEl)
            // 直接改 targetEl.style.opacity 会被它自身的 CSS transition（.25s）接住，变成
            // 一次可见的淡出——这段时间跟刚起飞的 clone2 叠在一起，就是"本体闪一下才淡出"。
            // 这一刻要的是瞬间藏起来（真正的淡出效果交给 clone2 的交叉淡变来演），借用
            // .phys-reveal-snap（揭示时同款技巧）临时关掉过渡、素质提交这一帧，再摘掉快照类。
            targetEl.classList.add('phys-reveal-snap')
            targetEl.style.opacity = '0'
            void targetEl.offsetWidth
            targetEl.classList.remove('phys-reveal-snap')
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
          _holdHoverUntilReveal(sourceEl)
          sourceEl.style.opacity = '0'
          const sc = _scrollParent(sourceEl)
          const box = revealInScroller(sc, sourceEl.getBoundingClientRect())
          flyMorph(box, sourceEl, _cloneLanding(sourceEl), restoreSourcePlaceholderStyle)
          return
        }
        // 已收合 → 先占位 FLIP 重新展开源卡（列恢复溢出），再算滚动容器，否则收合时列不溢出 → 取不到 sc
        const box0 = animateOpen(container, sourceEl)
        const sc = _scrollParent(sourceEl)
        // 锁列期间源卡收合，浏览器可能把 scrollTop 夹小了；展开后还原到拖动前，revealInScroller 再据此滚到原位
        if (sc && _savedScrollTop.has(sc)) {
          sc.scrollTop = _savedScrollTop.get(sc)
          const box = revealInScroller(sc, sourceEl.getBoundingClientRect())
          flyMorph(box, sourceEl, _cloneLanding(sourceEl), restoreSourcePlaceholderStyle)
        } else {
          const box = revealInScroller(sc, box0)
          flyMorph(box, sourceEl, _cloneLanding(sourceEl), restoreSourcePlaceholderStyle)
        }
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
            _holdHoverUntilReveal(el)
            el.style.opacity = '0'
            // 抽屉来源卡未命中抽屉时，生成的画布卡应落在抽屉层下方，避免飞行克隆
            // 覆盖抽屉内容。命中抽屉的路径会在上面的 absorb 分支中保留原有层级，正常飞入。
            if (sourceEl.closest('[data-project-drawer-dropzone]')) {
              holder.style.zIndex = '7'
            }
            const box = revealInScroller(_scrollParent(el), el.getBoundingClientRect())
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
        const el = document.querySelector<HTMLElement>(sel)
        const movedToAnotherContainer = el?.parentElement !== container
        if (el && el.isConnected && (el !== sourceEl || movedToAnotherContainer)) {
          if (el.offsetWidth > 0) {   // 落点可见 → 占位 FLIP 展开；双克隆同轨迹飞行 + 样式渐变
            animateOpen(el.parentElement!, el)   // 它为量 FLIP 会瞬间 display:none 落点卡，故滚动放其后
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

      // 3) 没变化 → 归位（原位若在列里滚出视口，也要快速滚回去）。
      landHome()
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
  _active!.raf = requestAnimationFrame(frame)
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
export function startMultiPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, count: number, extras: HTMLElement[] = [], opts: PhysicsDragOpts = {}) {
  if (!sourceEl || _active) return
  const session = dragRegistry.start(sourceEl)
  session.setPhase('dragging')
  _flushPendingCleanup(sourceEl)   // 同 startPhysicsDrag：只打断同一张卡上一趟还没飞完的动画
  for (const ex of extras) { if (ex) _flushPendingCleanup(ex) }
  const pointer = opts.pointer === true
  const pointerId = pointer ? (event as PointerEvent).pointerId : null
  if (!pointer) { try { (event as DragEvent).dataTransfer?.setDragImage(_transparentGhost(), 0, 0) } catch {} }
  if (pointer) { try { document.body.setPointerCapture(pointerId!) } catch {} }

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
      el = cloneForDrag(extraEl)
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
  const clone = cloneForDrag(sourceEl, { addClasses: ['phys-drag-clone'] })
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

    _active!.raf = requestAnimationFrame(frame)
  }

  function end() {
    if (!_active || !session.isCurrent()) return
    session.setPhase('landing')
    cancelAnimationFrame(_active.raf)
    _active = null
    document.body.classList.remove('phys-dragging')
    if (pointer) {
      document.removeEventListener('pointermove', onOver)
      document.removeEventListener('pointerup', end)
      document.removeEventListener('pointercancel', end)
      try { document.body.releasePointerCapture(pointerId!) } catch {}
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

    // 落点用克隆体此刻真实的视觉中心，不用 target/pos——理由同单选版 end()，pos.y 也要修正
    // GRABY 偏移才是视觉中心，见那边的注释。
    const cloneCenter = { x: pos.x, y: pos.y - GRABY + half.y }
    // 多选拖拽（看板/文件库）目前没有消费方需要 turn，固定给 0，不为它另起一套 velHistory。
    // context.pointer 带上原始指针位置——理由同单选版：调用方（dispatchDrop）自己的命中判定
    // 要跟这里下面「吸入文件夹/面包屑」的动画判定用同一个基准点，否则又会出现「动画演了吸入、
    // 数据其实没动」（cloneCenter 是卡片视觉中心，跟指针位置在细长目标上判定结果可能不一致）。
    if (opts.onDrop) { try { opts.onDrop(cloneCenter, { x: vel.x, y: vel.y, turn: 0 }, { w: rect.width, h: rect.height }, { pointer: { x: target.x, y: target.y }, pointerVelocity: { x: 0, y: 0 }, isLandingRegrab: false }) } catch (err) { console.error('[physicsDrag] onDrop failed', err) } }

    const dropX = cloneCenter.x, dropY = cloneCenter.y
    const SLOT = (box: Box) => `translate3d(${box.left.toFixed(2)}px, ${box.top.toFixed(2)}px, 0) scale(1)`

    const landing = new LandingState(); landing.begin()
    let onEnd: (e: TransitionEvent) => void = () => {}
    const flyTo = (box: Box, shrink: boolean) => {
      clone.style.transition = `transform 0.55s ${_SETTLE}, opacity 0.4s ease`
      if (shrink) {
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2
        clone.style.opacity = '0'
        clone.style.transform =
          `translate3d(${(cx - half.x).toFixed(2)}px, ${(cy - half.y).toFixed(2)}px, 0) scale(0.32)`
      } else {
        // 归位：飞回源卡并淡出（源卡始终可见，克隆体直接消失）
        clone.style.transform = SLOT(box)
        clone.style.opacity = '0'
      }
      let unregister = () => {}
      const finish = () => {
        if (landing.isDone()) return
        landing.finish()
        unregister()
        clone.removeEventListener('transitionend', onEnd)
        clone.remove()
        dragRegistry.finish(sourceEl, session)
      }
      unregister = _registerCleanup(sourceEl, finish)
      onEnd = finish
      clone.addEventListener('transitionend', onEnd)
      setTimeout(finish, 680)
    }

    // 松手即进入归位/落位飞行（见单选 end() 里同名注释 + _landingZIndex）：不再顶着压顶 z，
    // 改按卡片所在的层叠上下文动态取值，避免飞行路径盖住悬浮窗口、也避免被卡片自己所在的浮窗盖住
    clone.style.zIndex = String(resolveLandingZIndex(sourceEl))
    requestAnimationFrame(() => {
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
  _active!.raf = requestAnimationFrame(frame)
}

/**
 * pointer 模式下「按住不放越过阈值才算真的开拖，否则算一次点击」的判定，抽成通用函数
 * 前——ProjectCard.vue（看板卡）、useFileDragDrop.ts（文件/文件夹卡，单选/多选两种）、
 * useCardDrag.ts（画布贴纸）三处各自手写过一份几乎一样的「攒位移 → 判阈值 → 起
 * startPhysicsDrag/startMultiPhysicsDrag，否则当点击」，连 window 监听器的挂卸都是抄的。
 * 这里只收敛这段公共的「阈值判定 + 生命周期」外壳，真正“越过阈值后要怎么起拖”（选单选
 * 还是多选、传哪些 opts）仍然是各调用方自己的业务，通过 onDragStart 回调交还给它们，
 * 不强行假设只有一种起拖方式。
 */
export { startThresholdDrag }
export type { ThresholdDragOpts }
