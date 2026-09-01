import { runtime, type LandingRect } from './index'

export const MIND_CANVAS_SURFACE_ID = 'mind:canvas'
export const MIND_CANVAS_DRAWER_SURFACE_ID = 'mind:canvas-drawer'
export const MIND_PROJECT_DRAWER_SURFACE_ID = 'mind:project-drawer'
export const MIND_CANVAS_OBJECT_TYPE = 'mind-canvas-object'
export const MIND_PROJECT_OBJECT_TYPE = 'mind-project-object'
export const MIND_CANVAS_OBJECT_TYPES = [MIND_CANVAS_OBJECT_TYPE, MIND_PROJECT_OBJECT_TYPE] as const
/** 0.20.4 画布拖拽代理：抓取/命中抽屉时压住抽屉，仍低于顶部胶囊和聊天窗口。 */
export const MIND_CANVAS_DRAG_Z_INDEX = 31
/** 0.20.4 未命中抽屉时，landing 代理降到画布 UI 壳层之下。 */
export const MIND_CANVAS_LANDING_Z_INDEX = 7

/** 画布卡片的 Runtime 身份必须跨乐观插入和服务端落库保持稳定。 */
export function mindCanvasObjectId(item: { nodeId: number; clientKey?: string }): string {
  return `mind:${item.clientKey ?? item.nodeId}`
}

type LandingResolver = (destination: unknown) => LandingRect | null
type LandingTargetResolver = (destination: unknown) => HTMLElement | null

const landingResolvers = new Map<string, LandingResolver>()
const landingTargetResolvers = new Map<string, LandingTargetResolver>()
const activeMindLandings = new Set<string>()
const mindLandingSettledListeners = new Set<() => void>()
let mindLandingSettlingFrame: number | null = null

// Runtime 是 landing 生命周期的唯一事实源；这里仅把 Mind 专属对象映射到
// Store 的刷新闸门，不再由 MindCanvas 每帧手动推断 Runtime 是否仍在移动。
runtime.subscribe(event => {
  if (event.type !== 'move-visual-update' && event.type !== 'move-visual-end') return
  if (!event.objectId.startsWith('mind:')) return
  if (event.type === 'move-visual-update') beginMindLanding(event.objectId)
  if (event.type === 'move-visual-end') endMindLanding(event.objectId)
})

function cancelMindLandingSettling(): void {
  if (mindLandingSettlingFrame == null) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(mindLandingSettlingFrame)
  mindLandingSettlingFrame = null
}

function notifyMindLandingSettled(): void {
  mindLandingSettlingFrame = null
  if (activeMindLandings.size > 0) return
  for (const listener of [...mindLandingSettledListeners]) listener()
}

function scheduleMindLandingSettled(): void {
  cancelMindLandingSettling()
  if (typeof requestAnimationFrame !== 'function') {
    queueMicrotask(notifyMindLandingSettled)
    return
  }
  // regrab 的新 session 会在下一帧注册 active；再多等一帧，避免旧 session
  // settled 与新 optimistic 节点首帧之间触发一次过早的画布刷新。
  mindLandingSettlingFrame = requestAnimationFrame(() => {
    mindLandingSettlingFrame = requestAnimationFrame(notifyMindLandingSettled)
  })
}

/**
 * 画布业务层的乐观更新可能先于 Runtime landing 完成。实时事件刷新期间
 * 不应替换正在被 proxy 使用的 DOM，因此由 Mind 侧共享这段生命周期。
 */
export function beginMindLanding(objectId: string): void {
  cancelMindLandingSettling()
  activeMindLandings.add(objectId)
}

export function endMindLanding(objectId: string): void {
  activeMindLandings.delete(objectId)
  if (activeMindLandings.size === 0) {
    scheduleMindLandingSettled()
  }
}

export function isMindLandingActive(): boolean {
  return activeMindLandings.size > 0 || mindLandingSettlingFrame != null
}

export function onMindLandingSettled(listener: () => void): () => void {
  mindLandingSettledListeners.add(listener)
  return () => mindLandingSettledListeners.delete(listener)
}

export function registerMindLandingResolver(objectId: string, resolver: LandingResolver): () => void {
  landingResolvers.set(objectId, resolver)
  return () => {
    if (landingResolvers.get(objectId) === resolver) landingResolvers.delete(objectId)
  }
}

export function resolveMindLandingRect(objectId: string, destination: unknown): LandingRect | null {
  return landingResolvers.get(objectId)?.(destination) ?? null
}

export function registerMindLandingTargetResolver(objectId: string, resolver: LandingTargetResolver): () => void {
  landingTargetResolvers.set(objectId, resolver)
  return () => {
    if (landingTargetResolvers.get(objectId) === resolver) landingTargetResolvers.delete(objectId)
  }
}

export function resolveMindLandingTarget(objectId: string, destination: unknown): HTMLElement | null {
  return landingTargetResolvers.get(objectId)?.(destination) ?? null
}
