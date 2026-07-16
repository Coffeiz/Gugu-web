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
import { createFlipTransaction } from './animation/flipCoordinator'
import { animateFlyTo } from './animation/flyTo'
import { startMorphLifecycle } from './animation/morphLifecycle'
import type { DragSession } from './core/DragSession'
import { dragRegistry } from './core/DragRegistry'
import { integrateSpring } from './core/physics'
import { dispatchDragHandoff, installLandingHandoff } from './interaction/handoff'
import { startPhysicsDrag as startPhysicsDragRuntime } from './interaction/single'
import { startMultiPhysicsDrag as startMultiPhysicsDragRuntime } from './interaction/multi'
import { animateScroll, findScrollParent, layoutBoxAtTransitionsEnd, layoutBoxInScroller } from './interaction/dom'
import { startThresholdDrag, ThresholdDragOpts } from './interaction/threshold'
import { cloneForDrag, createLandingClone } from './visual/clone'
import { resolveLandingZIndex } from './visual/layer'
import { holdHoverUntilReveal, revealWithoutStaleHover } from './visual/reveal'

// 拖拽物理可选项（startPhysicsDrag / startMultiPhysicsDrag 共用）
export interface PhysicsDragOpts {
  /** 物理拖拽创建新会话后通知业务 adapter，供其保护自己的异步视觉回调。 */
  onSessionStart?: (session: DragSession) => void
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
  /** 需要跨分组重排时，使用调用方提供的列容器作为 FLIP 范围。 */
  flipContainer?: HTMLElement
  flipAllDescendants?: boolean
  // 看板已完成列的卡片跨年/月分组重挂载时，等待 Vue 完成一帧或多帧布局，再决定是否走
  // 完整 morph；避免把暂时 0×0 的目标误判成折叠目标而播放收缩动画。
  landingVisibilityWaitMs?: number
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
const _activeState = {
  get current() { return _active },
  set current(value: ActiveDrag | null) { _active = value },
}

// 落地飞行动画（flyTo/flyMorph）跑在独立的 rAF/timeout 里，跟 _active 生命周期不同步——
// end() 一开始就清空 _active，落地动画（0.55~0.7s）还在后台继续。这期间若立刻在原位重新抓
// 同一张卡，startPhysicsDrag 顶部会强制把源卡摆回可见（见下方注释），但上一次拖拽还没落地
// 完的克隆体不会被这一步清掉——于是「已复位的源卡」和「还在飞/还没消失的旧克隆」同屏重叠，
// 看起来像多出一张卡。
// 按「卡片元素」记账（不是全局一刀切）：只有新拖拽抓的正好是同一张卡，才打断它上一趟没放完
// 的落地动画；抓的是别的卡，互不相干的动画不受影响、照常播完——不然随手抓别的文件也会让刚
// 松手的那张瞬间归位，动画被腰斩。
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

function _childCards(container: HTMLElement, exclude: Element | null, allDescendants = false) {
  const elements = allDescendants
    ? [...container.querySelectorAll<HTMLElement>('[data-project-id], [data-file-id], [data-folder-key], [data-flip-target]')]
    : [...container.children] as HTMLElement[]
  return elements.filter(c =>
    c.nodeType === 1 && c !== exclude && !c.classList.contains('phys-drag-clone'))
}
const _rects = (els: Element[]) => els.map(e => e.getBoundingClientRect())

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
function _revealWithoutStaleHover(el: HTMLElement, pointerMode: boolean, onSettled?: () => void, keepControls = false, isActive = () => true) {
  revealWithoutStaleHover(el, pointerMode, onSettled, keepControls, isActive)
}

// 克隆开始落地时，目标本体已在鼠标下也不能激活 hover；这层状态一直保留到
// _revealWithoutStaleHover 在克隆动画结束后解除。与“揭示时才加”的旧做法相比，避免中途积累陈旧 hover。
function _holdHoverUntilReveal(el: HTMLElement) {
  holdHoverUntilReveal(el)
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
/**
 * @param {DragEvent|PointerEvent} event  原生 dragstart 事件，或 pointer 模式下越过阈值的 pointermove
 * @param {HTMLElement} sourceEl  被拖的卡片（一般传 event.currentTarget）
 * @param {object} [opts]  { spring, sway, tilt, grabY, lift, pointer, onDrop }
 *   pointer:true 改用 pointer 事件驱动（setPointerCapture 跳过每帧命中测试，省掉原生 dragover 的 HitTest）；
 *   onDrop({x,y}): pointer 模式下松手时回调，由调用方据落点执行业务移动（原生模式靠各列 @drop 落定）。
 */
export function startPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, opts: PhysicsDragOpts = {}) {
  startPhysicsDragRuntime(event, sourceEl, opts, {
    active: _activeState,
    easing: _SETTLE,
    createFlipTransaction,
    transparentGhost: _transparentGhost,
    registerCleanup: (session, cleanup) => session.addCleanup(cleanup),
    setRetarget: (target, retarget) => _pendingRetargets.set(target, retarget),
    clearRetarget: (target, retarget) => {
      if (_pendingRetargets.get(target) === retarget) _pendingRetargets.delete(target)
    },
    retargetLandings: _retargetLandings,
    childCards: _childCards,
    rects: _rects,
    scrollParent: findScrollParent,
    layoutBoxInScroller,
    layoutBoxAtTransitionsEnd,
    animateScroll,
    holdHoverUntilReveal: _holdHoverUntilReveal,
    revealWithoutStaleHover: _revealWithoutStaleHover,
    startPhysicsDrag,
  })
}
export function startMultiPhysicsDrag(event: PointerEvent | DragEvent, sourceEl: HTMLElement, count: number, extras: HTMLElement[] = [], opts: PhysicsDragOpts = {}) {
  startMultiPhysicsDragRuntime(event, sourceEl, count, extras, opts, {
    active: _activeState,
    easing: _SETTLE,
    transparentGhost: _transparentGhost,
    registerCleanup: (session, cleanup) => session.addCleanup(cleanup),
  })
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
