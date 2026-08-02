/**
 * 画布贴纸统一走全站卡片拖拽物理模块（同项目卡 ProjectCard.vue 的写法）：攒位移，越过
 * 阈值才真正起拖（否则当成点击）；拖拽视觉交给 startPhysicsDrag 的弹簧跟随 + 轻抬起。
 * sway（左右晃动）用默认值，跟看板卡/文件卡是同一套通用手感；tilt（3D 后仰）画布贴纸
 * 单独关掉——设计草案明确排除会改变文字渲染的 3D 后仰效果，sway 只是平面内的 rotateZ
 * 摆动，不在此列。阈值判定本身复用 usePhysicsDrag.ts 的 startThresholdDrag
 * （ProjectCard.vue/useFileDragDrop.ts 同一份，不再各自抄一遍）。
 *
 * 画布贴纸是绝对定位（依 x/y 世界坐标 + 外层 canvas-world 的 camera transform 摆放），不是
 * 列表重排——这里只用 startPhysicsDrag 的「跟手克隆 + 松手飞向新位置」视觉，落点换算成
 * 世界坐标交给调用方持久化，不借它的兄弟卡 FLIP/文件夹吸入语义（皆不适用，见 onDrop）。
 */
import { startPhysicsDrag, startThresholdDrag } from '../../../composables/usePhysicsDrag'
import { screenSizeToWorld } from '../core/coordinates'

export { screenSizeToWorld }

// 甩出去的惯性：把松手瞬间的速度（px/s，屏幕坐标）折算成一段"再飞一下"的距离，卡片抛得
// 越快落点越远，不是甩到哪就精确停在指针下——纯粹跟手反而没有"抛"的手感。COAST 是这段惯性
// 对应的等效时长，MAX 夹住极限速度下的最大惯性距离，避免用力一甩飞出老远难找回来。
const COAST_S = 0.12
const MAX_COAST_PX = 260
const COAST_STEPS = 8   // 惯性路径切几段小步做曲线外推，越多越平滑，8 段肉眼已经看不出折角
// 甩出去时手腕带的转弯幅度不封顶延伸到 COAST_S 全程会转过头（尤其瞬时转弯判定偶尔偏大时），
// 这里把整段惯性期间累计转过的角度夹在 ±0.9 弧度（约 ±52°）内，只取「一点弧度」的观感。
const MAX_TURN = 0.9

/** 把松手速度（+转弯角度）折算成惯性偏移（屏幕像素）。甩的过程手腕往往不是直线，抛出去的
 *  瞬间还带着转弯的角速度（见 usePhysicsDrag.ts 的 velHistory/turn）——这里不是简单地把
 *  最后一帧速度乘个时间线性外推，而是把惯性这一小段拆成若干步，每步都让速度方向按 turn
 *  折算出的角速度继续转一点再前进，路径因此会带一点弧度，跟直觉里"甩出去的东西还在转弯"
 *  更接近。ProjectRefCard.vue 直接嵌 ProjectCard.vue、没走下面这个 useCardDrag，但落点
 *  手感要跟其它画布贴纸一致，共用同一份系数/公式。 */
export function coastOffset(velocity: { x: number; y: number; turn?: number }) {
  const stepDt = COAST_S / COAST_STEPS
  const turn = Math.max(-MAX_TURN, Math.min(MAX_TURN, velocity.turn ?? 0))
  const angStep = turn / COAST_STEPS
  const cos = Math.cos(angStep), sin = Math.sin(angStep)
  let vx = velocity.x, vy = velocity.y
  let x = 0, y = 0
  for (let i = 0; i < COAST_STEPS; i++) {
    const nvx = vx * cos - vy * sin
    const nvy = vx * sin + vy * cos
    vx = nvx; vy = nvy
    x += vx * stepDt
    y += vy * stepDt
  }
  return {
    x: Math.max(-MAX_COAST_PX, Math.min(MAX_COAST_PX, x)),
    y: Math.max(-MAX_COAST_PX, Math.min(MAX_COAST_PX, y)),
  }
}

// 松手后克隆体不是瞬间到位——usePhysicsDrag.ts 的 flyMorph 用 0.55s 的强 ease-out
// （_SETTLE，cubic-bezier(0.22,1,0.36,1)：快进慢收）飞去计入惯性后的最终落点。落库用的
// 世界坐标是同步给出的（物理模块需要马上拿到落点算飞行目标，见下方 onDrop 的注释），但
// 连线不能跟着瞬间跳到终点——那样"卡片还在飞、线已经到了"，落地感全无。这里用同一份时长
// /缓动单独补一段插值，只用来喂 onDragMove（本地视觉，不再二次落库），让线跟克隆体的落地
// 飞行保持同步。
const LANDING_MS = 550

/** 用牛顿迭代求 cubic-bezier(x1,y1,x2,y2) 在给定 x（=进度 t，0~1）处的 y——不是随手挑一个
 *  「差不多也是快进慢收」的普通缓动函数就凑合用：便签/文件/项目卡的落地飞行走的是 CSS
 *  transition（浏览器按 _SETTLE 这条曲线插值），先前这里用 `1-(1-t)^3` 近似，形状跟
 *  cubic-bezier(0.22,1,0.36,1) 差得不算小——同起点同终点同时长，但飞行途中每一帧的具体
 *  位置都对不上，连线跟卡片"看着不是同一个动作"。这里精确复刻同一条曲线，两边逐帧位置
 *  才能真正重合。 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1
  const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x: number) => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-4) break
      const d = sampleDX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    return sampleY(t)
  }
}
// 跟 usePhysicsDrag.ts 的 _SETTLE 同一条曲线：cubic-bezier(0.22, 1, 0.36, 1)。
const _landingEase = cubicBezier(0.22, 1, 0.36, 1)
/** onDone 在插值播完（t 到 1、onUpdate 已经用精确的 to 值调用过最后一次）后触发一次——调用方
 *  用它来清掉「落地动画期间的连线覆盖位置」（见 MindCanvas.vue 的 landingPositions）：这时
 *  覆盖值跟 item.x/y 的真实落库值完全相等，摘掉覆盖、改读 item.x/y 不会有任何跳变。 */
export function animateLanding(
  from: { x: number; y: number },
  to: { x: number; y: number },
  onUpdate: (x: number, y: number) => void,
  onDone?: () => void,
  isActive: () => boolean = () => true,
): () => void {
  // 多等一帧再开始：usePhysicsDrag.ts 的 end() 在 onDrop 回调返回后，紧接着（同一个同步调用栈）
  // 自己也排了一个 requestAnimationFrame，用来读贴纸此刻的真实 DOM 位置算克隆体飞行目标——
  // 那份"真实位置"正是上面 onDropAt 刚同步落库的最终坐标（Vue 的响应式更新在这之前已经生效）。
  // 这里第一步会把「连线覆盖位置」拉回"松手瞬间、还没算惯性"的起点，如果这一步跟物理模块那个
  // 读位置的 rAF 排进同一帧、又恰好排在它前面，物理模块就会读到被拉回的旧位置——卡片自己的
  // 落地飞行就飞错方向、飞不出该有的距离。多包一层 rAF，保证我们真正开始改覆盖位置是在物理
  // 模块那次读取"之后"的下一帧，两边不会撞在同一帧里抢跑。
  let cancelled = false
  let outerRaf = 0
  let frameRaf = 0
  outerRaf = requestAnimationFrame(() => {
    if (cancelled || !isActive()) return
    const start = performance.now()
    function step(now: number) {
      if (cancelled || !isActive()) return
      const t = Math.min(1, (now - start) / LANDING_MS)
      const e = _landingEase(t)
      onUpdate(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e)
      if (t < 1) frameRaf = requestAnimationFrame(step)
      else onDone?.()
    }
    frameRaf = requestAnimationFrame(step)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(outerRaf)
    cancelAnimationFrame(frameRaf)
  }
}

export function useCardDrag(opts: {
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number }
  // 画布便签（NoteSticker.vue）复用 NoteCard.vue 本体，点击进编辑态走 NoteCard 自己的
  // onBodyClick（见其注释），不需要 useCardDrag 再额外派发一次点击语义——可选。
  onClick?: () => void
  // 松手时的世界坐标——卡片左上角该落在哪（不是中心）。物理模块给的克隆体真实视觉中心 +
  // 真实视觉尺寸（见 usePhysicsDrag.ts 的 onDrop 的 size 参数）已经在这里换算成左上角，
  // 调用方不用再自己拿存储侧的假定尺寸反推——卡片实际渲染多高（比如项目卡片客户名有没有、
  // 是否完成态换了行）跟假定尺寸经常对不上，拿假定尺寸反推出来的落点/连线锚点会跟着偏
  // （用户反馈"连线点比卡片中心低""落点偏高"，根源都是这个）。
  onDropAt: (worldX: number, worldY: number) => void
  // 拖拽进行中每帧回调（世界坐标，卡片左上角，换算方式同 onDropAt）——不落库，只用来让
  // 关系连线实时跟着正在拖的这张贴纸一起动（贴纸本体此刻由 startPhysicsDrag 的克隆接管
  // 显示，源贴纸是隐藏的，只有连线层会因为这个回调而重绘，不会有本体位置跳变的视觉冲突）。
  // 传入的中心点是克隆体此刻真实的视觉中心（usePhysicsDrag.ts 的 onFollow，经过弹簧积分、
  // 带阻尼延迟），不是瞬时指针位置——用瞬时指针位置会让连线比克隆体先到（克隆有弹簧阻力、
  // 指针没有），线跟卡片对不上、也没有该有的"拖拽阻力感"。
  onDragMove?: (worldX: number, worldY: number) => void
  // 松手后、克隆体飞去最终落点的这 0.55s 期间每帧回调一次插值出的位置（左上角）——跟
  // onDragMove 是两回事：onDragMove 直接反映在 item.x/y 上（贴纸本体隐藏中，改了也没事）；
  // 这个不落到 item.x/y 上（贴纸这时已经同步跳到最终落点了，见 onDropAt 调用处的注释），
  // 只用来单独喂连线一份还没到终点的「过渡位置」，配合 onLandingDone 在动画播完时清掉这份
  // 覆盖——不然 item.x/y 提前到位会让连线先闪一下终点、再跳回起点重新播这段惯性动画，见
  // MindCanvas.vue 的 landingPositions。即使没有惯性偏移也会走一轮：除了让关系线和卡片
  // 同步，它还是画布连线命中的"落地中"门禁，飞行结束前不能把隐藏本体当作可吸附目标。
  onLanding?: (worldX: number, worldY: number) => void
  onLandingDone?: () => void
  // 拖拽发起点（如小抓手）跟「要飞起来的那张卡」不是同一个元素时用这个指定要拖的元素，
  // 不传则退回 event.currentTarget（发起点自己就是整张卡的常见情形）。
  getDragEl?: () => HTMLElement | null
  exclude?: (target: EventTarget | null) => boolean
  // 画布相机当前缩放（MindCanvas.vue 的 camera.scale）——卡片套在 .canvas-world 的
  // transform:scale 祖先底下，克隆体脱离这层祖先后要靠这个值自己补回视觉缩放，见
  // usePhysicsDrag.ts 的 contentScale。传取值函数（不是静态数字）：抓着卡片不放的时候
  // 画布还能滚轮继续缩放，物理模块每帧都会重新调用它读「当下」的缩放，不传按 1 处理。
  contentScale?: () => number
  // 默认轻抬起 3%，便签/项目/活动贴纸保留这份空间感；文件卡传 1，避免非整数缩放让文件名变糊。
  lift?: number
  // 画布项目卡拖回已打开的项目抽屉时，命中该区域就不再计算画布落点，而是缩小吸入抽屉。
  resolveAbsorbTarget?: (pointer: { x: number; y: number }) => HTMLElement | null
  // 吸入后列表会因响应式数据更新重新插入对应的项目卡。下一帧物理动画应以那张卡为终点，
  // 而不是只飞向命中的整个抽屉容器。
  resolveAbsorbLandingTarget?: () => HTMLElement | null
  // 见 usePhysicsDrag.ts 同名选项：resolveAbsorbLandingTarget 轮询目标卡的等待上限，
  // 覆盖住调用方自己那次吸入请求的网络延迟，不传退回其历史默认值 300ms。
  absorbLandingWaitMs?: number
  // 项目回抽屉保留整张卡飞入目标位；文件夹等传统吸收交互仍可走默认的缩小吸入。
  absorbShrink?: boolean
  onAbsorb?: () => void
  // 见 usePhysicsDrag.ts 同名选项：落地飞行（clone2）中途被重新抓起时，把这次手势转手
  // 给落点本体自己的拖拽逻辑接力，而不是拿这次吸入请求的 opts 硬套在落点本体上继续拖。
  delegateLandingRegrab?: boolean
}) {
  // 同一张卡尚在落地飞行时又被抓起，旧的关系线插值绝不能继续写 landingPositions；否则
  // RelationLayer 会优先读旧覆盖位置，视觉线脱离新抓住的克隆。取消后也要立即通知调用方
  // 清掉覆盖表，不能等下一帧。
  let cancelLanding: (() => void) | null = null
  let activeSession: (() => boolean) | null = null
  function cancelActiveLanding() {
    if (!cancelLanding) return
    cancelLanding()
    cancelLanding = null
    opts.onLandingDone?.()
  }
  function startDrag(
    event: PointerEvent,
    card: HTMLElement,
    initialRect?: { left: number; top: number; width: number; height: number },
    initialHover = false,
    isLandingRegrab = false,
  ) {
    cancelActiveLanding()
    let absorbTarget: HTMLElement | null = null
    startPhysicsDrag(event, card, {
      onSessionStart: session => {
        activeSession = () => session.isCurrent()
      },
      pointer: true, skipAbsorb: !opts.resolveAbsorbTarget, tilt: 0, lift: opts.lift ?? 1.03,
      resolveAbsorbTarget: opts.resolveAbsorbTarget ? () => absorbTarget : undefined,
      resolveAbsorbLandingTarget: opts.resolveAbsorbLandingTarget,
      absorbLandingWaitMs: opts.absorbLandingWaitMs,
      absorbShrink: opts.absorbShrink,
      delegateLandingRegrab: opts.delegateLandingRegrab,
      // 飞行中的 holder 被再次抓起时，物理模块会递归启动下一段拖拽；先停掉上一段只供
      // RelationLayer 使用的落地插值，避免旧 landingPositions 继续覆盖新克隆的位置。
      onRegrabStart: cancelActiveLanding,
      // 无限画布没有"卡片顶部附近拈起"这个参照系（那是看板卡沿用的手感），抓哪张贴纸都该是
      // 贴纸中心跟手，不然矮贴纸（活动/文件）看着几乎贴在指针上、高贴纸（便签）又明显吊在
      // 指针下方一截，四种贴纸手感不一致。
      centerGrab: true,
      contentScale: opts.contentScale,
      // 画布贴纸铺满整个浏览器（含侧栏背后那一段，见 MindCanvas.vue），拖拽克隆默认压在
      // 拖拽期间克隆先高于抽屉，方便把卡片拖到抽屉区域；松手确认未命中后，物理模块会把
      // 落地克隆降到抽屉下面。这里传了 dragZIndex 后，两段飞行都会直接用这个数，不会各走
      // 一套算法（落地那段默认按祖先动态探测，容易先摸到贴纸自己内联的 item.z，那个值
      // 随建卡数量单调递增，迟早会长到超过侧栏的 20），两段交接时层级也不会跳一下。
      dragZIndex: 31,
      initialRect,
      initialHover,
      isLandingRegrab,
      onFollow: opts.onDragMove
        ? ({ x, y }, size) => {
            const world = opts.screenToWorld(x, y)
            const { w, h } = screenSizeToWorld(opts.screenToWorld, size)
            opts.onDragMove!(world.x - w / 2, world.y - h / 2)
          }
        : undefined,
      onDrop: ({ x, y }, velocity, size, context) => {
        absorbTarget = opts.resolveAbsorbTarget?.(context?.pointer ?? { x, y }) ?? null
        if (absorbTarget) {
          opts.onAbsorb?.()
          return
        }
        const coast = coastOffset(velocity)
        const dropCenter = opts.screenToWorld(x, y)
        const landCenter = opts.screenToWorld(x + coast.x, y + coast.y)
        const { w, h } = screenSizeToWorld(opts.screenToWorld, size)
        const dropTopLeft = { x: dropCenter.x - w / 2, y: dropCenter.y - h / 2 }
        const landTopLeft = { x: landCenter.x - w / 2, y: landCenter.y - h / 2 }
        // 落库坐标必须同步给出：usePhysicsDrag.ts 的 end() 紧接着在同一个宏任务里读
        // 贴纸最新的 DOM 位置来算克隆体飞行目标，晚一步（比如等下面这段插值播完再落库）
        // 会让它读到旧位置、飞错地方。落地动画期间连线要跟着走，靠下面单独一段插值补，
        // 不依赖也不推迟这次落库；插值不写回 item.x/y（会闪一下终点，见 onLanding 的
        // 注释），只喂 onLanding。
        opts.onDropAt(landTopLeft.x, landTopLeft.y)
        if (opts.onLanding) {
          // 先同步写一次起点：目标卡的真实 item.x/y 已经跳到终点，本体虽不可见仍能被
          // elementFromPoint 命中。MindCanvas 用这次回调立刻把它标记为"落地中"，避免
          // 连线拖拽提前吸到仍在飞的卡片；后续逐帧插值只负责关系线视觉位置。
          opts.onLanding(dropTopLeft.x, dropTopLeft.y)
          cancelLanding = animateLanding(dropTopLeft, landTopLeft, opts.onLanding, () => {
            cancelLanding = null
            opts.onLandingDone?.()
          }, activeSession ?? undefined)
        }
      },
    })
  }
  function onPointerDown(event: PointerEvent) {
    startThresholdDrag(event, {
      getCard: opts.getDragEl ? () => opts.getDragEl!() : undefined,
      exclude: opts.exclude,
      onDragStart: (ev, card) => {
        startDrag(ev, card)
      },
      onClick: opts.onClick,
    })
  }
  // 落地克隆仍在飞行时的接力入口。初始位置量自 holder 的实时视觉矩形，而不是已经写入
  // 最终坐标的本体，保证用户抓到眼前 clone2 后不会瞬移回落点再开始拖。
  function startLandingRegrab(event: PointerEvent, initialRect: { left: number; top: number; width: number; height: number }) {
    const card = opts.getDragEl?.()
    if (!card) return
    startDrag(event, card, initialRect, true, true)
  }
  /** 外部素材越过阈值后由刚挂载的画布卡直接启动普通拖拽。这里刻意不传 initialRect：
   * 初始矩形是“落地飞行再抓取”的专用补偿，首次入画布若带上它会绕开标准 clone2 路径。 */
  function startImmediateDrag(event: PointerEvent) {
    const card = opts.getDragEl?.()
    if (!card) return
    startDrag(event, card)
  }
  return { onPointerDown, startImmediateDrag, startLandingRegrab }
}
