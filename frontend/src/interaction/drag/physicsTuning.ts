import { reactive, watch } from 'vue'

/**
 * 拖拽物理的运动参数——CardProxy 路径（目前只有 projectDrag）跟手/落地都要用到这几个
 * 数值，是正式运行时依赖，不是调试专用代码。singleProxy.ts 从这里读默认值。
 *
 * 生产环境只需要读这几个固定数值，不需要 Vue 的响应式 Proxy（没有任何 UI 会在生产
 * 环境响应它们的变化）——`reactive()`、`BroadcastChannel`、`watch` 这些跟调试面板
 * 相关的代码只在 DEV 下才会真正跑起来。生产构建时 `import.meta.env.DEV` 是编译期
 * 常量 `false`，下面这些分支都是死代码会被摇树掉，最终只留下一个普通对象字面量。
 */
/**
 * 用 response（响应时长，秒）+ dampingRatio（阻尼比，0~1）而不是原始的
 * stiffness/damping 描述弹簧——这套参数化照抄 iOS UISpringTimingParameters /
 * SwiftUI .spring() 的做法：response 直接对应"大概多久到位"，dampingRatio 直接
 * 对应"回不回弹、弹几下"，两个维度都有明确的时间/物理直觉，比直接填刚度/阻尼系数
 * 好调得多——原始的 stiffness/damping 组合起来的效果不直观，改一个会连带影响
 * "多久到位"这个人真正关心的东西，很难凭手感调进某个具体区间。
 *
 * 换算公式（质量归一化为 1）：
 *   stiffness = (2π / response)²
 *   damping   = 4π × dampingRatio / response
 * 见 springParamsFromResponse()。
 */
export interface SpringResponseTuning {
  /** 响应时长(秒)：大概多久能到位，越小收敛越快。 */
  response: number
  /** 阻尼比：1 = 不回弹（临界阻尼），<1 会回弹/画弧线，越接近 0 弹得越夸张。 */
  dampingRatio: number
}

export interface DragPhysicsTuning {
  /** 跟手阶段弹簧（response/dampingRatio 参数化，见上）。 */
  follow: SpringResponseTuning
  /** 横向摆动系数（SWAY）：移动速度换算成 rotateZ 甩动的比例。 */
  followSway: number
  /** 基础后仰角（TILT，deg）：拾起时固定叠加的 3D 倾斜角。 */
  followTilt: number
  /** 落地阶段弹簧（response/dampingRatio 参数化，见上）。 */
  landing: SpringResponseTuning
  /** 松手时当前视觉速度的倍率，只增强惯性，不改变最终落点。 */
  releaseImpulse: number
  /** 松手速度上限，避免极端指针速度造成不可控飞行。 */
  releaseVelocityCap: number
}

export const DEFAULT_DRAG_PHYSICS_TUNING: DragPhysicsTuning = {
  follow: { response: 0.36, dampingRatio: 0.85 },
  followSway: 0.25,
  followTilt: 5,
  landing: { response: 0.31, dampingRatio: 0.54 },
  releaseImpulse: 1.1,
  releaseVelocityCap: 2400,
}

/** response/dampingRatio → CardProxy 弹簧要的 stiffness/damping（质量归一化为 1）。 */
export function springParamsFromResponse(tuning: SpringResponseTuning): { stiffness: number; damping: number } {
  const response = Math.max(0.01, tuning.response)
  const stiffness = (2 * Math.PI / response) ** 2
  const damping = (4 * Math.PI * tuning.dampingRatio) / response
  return { stiffness, damping }
}

// "保存"写这个 key——代表"我认可的生产参数"，页面加载时读它做初始值。
const STORAGE_KEY = 'gugu-dev-drag-physics-tuning'
// "设为默认"写这个 key——纯调试锚点，跟生产默认值无关，只是"恢复默认值"按钮
// 优先回到的基准点，方便反复试验时有个可回退的起点。
const ANCHOR_KEY = 'gugu-dev-drag-physics-anchor'
const CHANNEL_NAME = 'gugu-dev-drag-physics-tuning'

function readJson(key: string): Partial<DragPhysicsTuning> | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** 只在 DEV 下调用——从 localStorage 读上次保存的值，跟默认值做一次浅合并（防止
 * 以后新增字段时，旧的存档缺字段导致 undefined）。生产环境这个函数不会被调用到，
 * 摇树后连函数体都不会进产物。 */
function loadSavedTuning(): DragPhysicsTuning {
  return { ...DEFAULT_DRAG_PHYSICS_TUNING, ...readJson(STORAGE_KEY) }
}

/** 面板"保存"按钮调用——把当前值写进 localStorage，代表"这是我认可的生产参数"，
 * 刷新页面、开新标签页都会读到这份值。真正要变成生产环境实际编译进去的默认值，
 * 还是得把这份值写进这个文件里的 DEFAULT_DRAG_PHYSICS_TUNING（浏览器改不了源码，
 * 见 copyTuningAsCode()）。 */
export function saveDragPhysicsTuning(): void {
  if (!import.meta.env.DEV) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dragPhysicsTuning))
}

export function clearSavedDragPhysicsTuning(): void {
  if (!import.meta.env.DEV) return
  localStorage.removeItem(STORAGE_KEY)
}

/** 面板"设为默认"按钮调用——只是存一个调试锚点，不代表生产参数。 */
export function setDragPhysicsTuningAnchor(): void {
  if (!import.meta.env.DEV) return
  localStorage.setItem(ANCHOR_KEY, JSON.stringify(dragPhysicsTuning))
}

/** 面板"恢复默认值"调用——优先回到锚点（如果设过），没设过锚点才回到代码里
 * 写死的原始默认值。 */
export function resetDragPhysicsTuning(): void {
  const anchor = readJson(ANCHOR_KEY)
  Object.assign(dragPhysicsTuning, DEFAULT_DRAG_PHYSICS_TUNING, anchor ?? {})
}

/** 生成一段可以直接粘进 DEFAULT_DRAG_PHYSICS_TUNING 的代码——"保存"的值要真正
 * 变成生产默认值，唯一路径是改这个文件的源码，浏览器运行时做不到自己改自己。
 * 处理了 follow/landing 这两层嵌套对象，不是简单 ${value} 字符串拼接（那样嵌套
 * 对象会被拼成没用的 "[object Object]"）。 */
export function copyDragPhysicsTuningAsCode(): string {
  const serialize = (value: unknown, indent: string): string => {
    if (value !== null && typeof value === 'object') {
      const inner = Object.entries(value as Record<string, unknown>)
        .map(([key, val]) => `${indent}  ${key}: ${serialize(val, indent + '  ')},`)
        .join('\n')
      return `{\n${inner}\n${indent}}`
    }
    return String(value)
  }
  return serialize(dragPhysicsTuning, '')
}

export const dragPhysicsTuning: DragPhysicsTuning = import.meta.env.DEV
  ? reactive(loadSavedTuning())
  : DEFAULT_DRAG_PHYSICS_TUNING

// 跨标签页实时同步：一个标签页改了 slider，另一个标签页立刻看到——两个标签页是
// 两个独立的 JS 内存，reactive 对象互相看不见，靠 BroadcastChannel 广播变化。
// applyingRemote 防止"收到广播 → 写本地 → 触发 watch → 又广播出去"无限循环。
// 注意：BroadcastChannel 会把消息回传给发送者，所以 postMessage 前也要设置标志，
// 否则 watch 回调异步执行时标志已被重置，仍会触发循环。
if (import.meta.env.DEV && typeof BroadcastChannel !== 'undefined') {
  const channel = new BroadcastChannel(CHANNEL_NAME)
  let applyingRemote = false

  watch(dragPhysicsTuning, value => {
    if (applyingRemote) return
    applyingRemote = true
    // { ...value } 只是浅拷贝——follow/landing 这两个字段现在是嵌套对象，reactive()
    // 会把嵌套对象也代理成 Proxy，浅拷贝出来的还是 Proxy 本身。BroadcastChannel 的
    // structured clone 没法克隆 Proxy，会直接抛 DataCloneError，而且是在 watch 回调
    // 里同步抛出，会打断 Vue 的调度导致界面看起来"改了没反应"。这里的数据全是纯数字，
    // JSON 往返一次就能把 Proxy 完全剥掉，比手写深拷贝简单可靠。
    channel.postMessage(JSON.parse(JSON.stringify(value)))
    applyingRemote = false
  }, { deep: true, flush: 'sync' })

  channel.onmessage = event => {
    applyingRemote = true
    Object.assign(dragPhysicsTuning, event.data)
    applyingRemote = false
  }
}
