/**
 * 画布相机（平移/缩放）的纯逻辑层，被 MindCanvas.vue 组装成交互。
 *
 * 贴纸自身的拖拽不在这里——统一走 interaction runtime 的卡片拖拽，跟项目卡/文件卡同一套手感，
 * 这里只管相机怎么跟手指/滚轮走。
 */
import { reactive, type Ref } from 'vue'
import type { MindCanvasItem } from '@/services/api'

export interface CanvasCamera { x: number; y: number; scale: number }

/** 各类型贴纸没存 w/h 时的默认渲染尺寸——四种贴纸组件（NoteSticker/EntitySticker/
 *  FileRefCard/ProjectRefCard）自己的 stickerStyle 和这里必须是同一份数字，任何一处单独
 *  改了数字都会导致「贴纸实际渲染多大」和「连线/连接点该画在哪」对不上：连接点是 CSS
 *  `top:50%` 相对贴纸自己的真实渲染盒定的，天然准确；连线端点/拖拽落点却是靠这份表算的，
 *  一旦表里的数字跟贴纸实际尺寸不一致，连线就会画到贴纸外面、松手落点也会偏——踩过这个坑
 *  （之前 itemAnchor/itemCenter 统一写死 244×148，实际只有便签是这个尺寸），全挪到这一处
 *  单一数据源，四个贴纸组件也从这里导入，不再各自维护一份数字。 */
export function defaultItemSize(item: MindCanvasItem): { w: number; h: number } {
  if (item.node.kind === 'canvas_note') return { w: 244, h: 148 }
  // 120 是 ProjectCard.vue 在 240 宽下的自然渲染高度估算（卡体上下内边距 24 + 三行内容各自
  // 的 gap 24 + 名称/星级行 18 + 客户/阶段行 ~13 + 日期/进度行 ~13 + 阶段进度条 5 + 边框 2，
  // 单行文案不换行时约 95~120px），不是随手取的 150——之前的 150 明显偏大：ProjectRefCard.vue
  // 曾经靠 `.proj-card{height:100%}` 把卡片强行撑到 150，但父级 .pr-wrap 只有 min-height
  // （没有 height），百分比高度在这种情况下解不出来，`height:100%` 其实从未真正生效过，
  // .proj-card 一直是按自己内容的自然高度渲染（~100~120px）。这份"假设高度"被两处地方各自
  // 独立使用——拖拽落点换算（ProjectRefCard.vue 的 onCanvasDrop/onFollow，拿它当卡片总高去
  // 反推中心点）和连线锚点（RelationLayer.vue，拿它算 item.y+h/2 是不是卡片竖直中点）——
  // 假设值比真实渲染高度多出 30px，落点算出来的"中心"整体偏高（松手位置往上跳），连线锚点
  // 跟真实卡片中点（由 CSS top:50% 定的圆点位置）也对不上（线看着不在正中间）。跟 FileCard
  // 同一个原则：默认值选得比自然高度稍小，内容稍长时会被撑破、看不出明显空白，比选大了更安全。
  if (item.node.refType === 'project') return { w: 240, h: 120 }
  // 140 是 FileCard.vue 默认参数（iconSize:86/areaHeight:90）在图标模式下的自然渲染高度
  // （icon-area 90 + 标题/元信息两行 ≈ 50），不是随手取的整数——用小于自然高度的默认值，
  // 强撑出来的 min-height 就会被内容撑破，看着卡片下方多一截空白（"文件卡还是长"那个坑）。
  if (item.node.refType === 'file') return { w: 156, h: 140 }
  return { w: 220, h: 96 }   // 活动等其它引用类型，见 EntitySticker.vue
}
export function itemSize(item: MindCanvasItem): { w: number; h: number } {
  const fallback = defaultItemSize(item)
  return { w: item.w || fallback.w, h: item.h || fallback.h }
}

/** 贴纸几何中心（世界坐标）——连线拖拽起点找"这张贴纸大概在哪"时用这个（不用精确到某条边）。
 *  可选 pos：不读 item.x/y，改用这个坐标（配合 RelationLayer.vue 的落地动画覆盖位置，
 *  见 itemAnchorSide 的说明）。 */
export function itemCenter(item: MindCanvasItem, pos?: { x: number; y: number }) {
  const { w, h } = itemSize(item)
  const x = pos?.x ?? item.x, y = pos?.y ?? item.y
  return { x: x + w / 2, y: y + h / 2 }
}

/** 贴纸边缘固定一侧的连接点（世界坐标，对应 conn-dot 的位置）——不看对方在哪，只看
 *  「要左边还是右边」这个既定结论。RelationLayer.vue 给已建立的关系用这个：出边侧只在
 *  关系第一次画出来那一刻按当时位置判一次并记住（见 RelationLayer.vue 的 anchorSideCache），
 *  之后卡片挪到哪儿都不重判——用户拖圆点连线时"从哪一侧拖出去"是明确动作，不该因为卡片
 *  后来移动位置就把端点从左边悄悄跳到右边。
 *  可选 pos：卡片落地动画期间，item.x/y 已经同步跳到最终落点（物理模块需要这份真实位置去
 *  算克隆体飞行目标），但连线不能跟着瞬间跳过去再倒退回来播动画——那样会先闪一下终点、
 *  再跳回起点重新播，很难看。这种时候调用方传入落地动画当前插值出的位置，覆盖掉 item.x/y，
 *  见 MindCanvas.vue 的 landingPositions。 */
export function itemAnchorSide(item: MindCanvasItem, right: boolean, pos?: { x: number; y: number }) {
  const { w, h } = itemSize(item)
  const x = pos?.x ?? item.x, y = pos?.y ?? item.y
  return { x: x + (right ? w : 0), y: y + h / 2 }
}

/** 贴纸边缘的连接点（世界坐标）：朝哪边的贴纸就出哪一侧的边，靠端点朝向另一端的方位实时
 *  选左/右——只给「还没成为固定关系」的场景用（画拖拽中的预览线，见 MindCanvas.vue），
 *  跟手挪动鼠标时线该跟着换边。已建立的关系不用这个动态版本，见上面 itemAnchorSide。 */
export function itemAnchor(item: MindCanvasItem, towardX: number) {
  const { w } = itemSize(item)
  const onRight = towardX > item.x + w / 2
  return itemAnchorSide(item, onRight)
}

export type AnchorSide = 'left' | 'right' | 'top' | 'bottom'

/** 关系在一张画布上的端点方向。关系本身是全局语义，左右从哪一侧出线则属于画布视图状态，
 *  存在 MindMap.data_json 的 relationAnchors 里。 */
export interface RelationAnchorSides {
  srcSide: AnchorSide
  dstSide: AnchorSide
}

/** 已建立关系的出边侧，只在关系第一次画出来那一刻判一次（配合 RelationLayer.vue 的
 *  anchorSideCache 冻结）——只在左右两侧里选：连接点本身（conn-dot）只长在贴纸左右边，
 *  没有上/下的圆点可拖，画出来的线若从上/下边出，会跟"关系是从边缘圆点拖出来的"这个交互
 *  语言对不上（曾经按纵向错开程度选过上/下边，两张贴纸横向排布改动后线还固定拖在原来那条
 *  边，看着就是从卡片上/下方莫名其妙钻出来）。两张贴纸主要是纵向错开时的自然弧线，靠下面
 *  sidePath 的"顺着左右边法线方向探出去一段再拐"来给，不需要真的从上/下边出。 */
export function pickAnchorSide(fromCenter: { x: number; y: number }, towardCenter: { x: number; y: number }): AnchorSide {
  return towardCenter.x >= fromCenter.x ? 'right' : 'left'
}

/** 贴纸四边任意一侧的连接点（世界坐标）——itemAnchorSide 的四向版本（top/bottom 目前没有
 *  调用方在用，pickAnchorSide 只会选 left/right，保留这两个分支只是让类型完整、不是死代码
 *  排查目标）。pos 覆盖的用途同 itemAnchorSide。 */
export function itemAnchorAt(item: MindCanvasItem, side: AnchorSide, pos?: { x: number; y: number }): { x: number; y: number } {
  const { w, h } = itemSize(item)
  const x = pos?.x ?? item.x, y = pos?.y ?? item.y
  if (side === 'left') return { x, y: y + h / 2 }
  if (side === 'right') return { x: x + w, y: y + h / 2 }
  if (side === 'top') return { x: x + w / 2, y }
  return { x: x + w / 2, y: y + h }
}

const MIN_SCALE = 0.45
const MAX_SCALE = 1.7

export function useMindCanvas(viewportRef: Ref<HTMLElement | null>) {
  const camera = reactive<CanvasCamera>({ x: 0, y: 0, scale: 1 })

  function centerView() {
    const viewport = viewportRef.value
    if (!viewport) return
    camera.x = viewport.clientWidth / 2
    camera.y = viewport.clientHeight / 2
    camera.scale = 1
  }

  // clientX/clientY 是浏览器给的视口坐标，跟 .mind-canvas 自己在视口里具体贴在哪儿无关；
  // camera.x/y 是相对 .mind-canvas 自身左上角量的（centerView 用的是它自己的 clientWidth/
  // clientHeight）。两者要换算，得先把 clientX/Y 减去 .mind-canvas 左上角的视口偏移——画布
  // 现在紧挨着侧栏右缘摆放（不再铺满整个浏览器、压到侧栏底下，见 MindCanvas.vue 的
  // .mind-canvas 定位），这份偏移不再是 0，不减会让所有指针换算出的世界坐标整体偏出侧栏宽
  // 那么多（点哪儿都对不上，连线/拖拽落点跟着全错）。
  function screenToWorld(clientX: number, clientY: number) {
    const rect = viewportRef.value?.getBoundingClientRect()
    const localX = rect ? clientX - rect.left : clientX
    const localY = rect ? clientY - rect.top : clientY
    return { x: (localX - camera.x) / camera.scale, y: (localY - camera.y) / camera.scale }
  }

  function zoomAt(screenX: number, screenY: number, nextScale: number) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
    const worldX = (screenX - camera.x) / camera.scale
    const worldY = (screenY - camera.y) / camera.scale
    camera.scale = scale
    camera.x = screenX - worldX * scale
    camera.y = screenY - worldY * scale
  }
  function workspaceCenter() {
    const viewport = viewportRef.value
    if (!viewport) return { x: 0, y: 0 }
    // 画布铺满浏览器，但左侧被导航栏覆盖；缩放操作以可见工作区的中心为锚点。
    const sidebarWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 220
    return { x: (viewport.clientWidth + sidebarWidth) / 2, y: viewport.clientHeight / 2 }
  }
  function zoomAtCenter(delta: number) {
    const center = workspaceCenter()
    zoomAt(center.x, center.y, camera.scale + delta)
  }
  function onWheel(event: WheelEvent) {
    const viewport = viewportRef.value
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const factor = event.deltaY < 0 ? 1.1 : 0.9
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, camera.scale * factor)
  }

  let pan: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null
  function startPan(event: PointerEvent) {
    pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: camera.x, originY: camera.y }
    viewportRef.value?.setPointerCapture(event.pointerId)
  }
  function panMove(event: PointerEvent) {
    if (pan?.pointerId !== event.pointerId) return false
    camera.x = pan.originX + event.clientX - pan.startX
    camera.y = pan.originY + event.clientY - pan.startY
    return true
  }
  function panEnd(event: PointerEvent) {
    if (pan?.pointerId !== event.pointerId) return false
    viewportRef.value?.releasePointerCapture(pan.pointerId)
    pan = null
    return true
  }

  return {
    camera, centerView, screenToWorld, zoomAt, zoomAtCenter, workspaceCenter, onWheel,
    startPan, panMove, panEnd,
  }
}
