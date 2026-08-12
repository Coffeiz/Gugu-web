import type { LandingRect } from './index'

export const MIND_CANVAS_SURFACE_ID = 'mind:canvas'
export const MIND_DRAWER_SURFACE_ID = 'mind:drawer'
export const MIND_CANVAS_OBJECT_TYPE = 'mind-canvas-object'
export const MIND_PROJECT_OBJECT_TYPE = 'mind-project-object'
export const MIND_CANVAS_OBJECT_TYPES = [MIND_CANVAS_OBJECT_TYPE, MIND_PROJECT_OBJECT_TYPE] as const

/** 画布卡片的 Runtime 身份必须跨乐观插入和服务端落库保持稳定。 */
export function mindCanvasObjectId(item: { nodeId: number; clientKey?: string }): string {
  return `mind:${item.clientKey ?? item.nodeId}`
}

type LandingResolver = (destination: unknown) => LandingRect | null
type LandingTargetResolver = (destination: unknown) => HTMLElement | null

const landingResolvers = new Map<string, LandingResolver>()
const landingTargetResolvers = new Map<string, LandingTargetResolver>()

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
