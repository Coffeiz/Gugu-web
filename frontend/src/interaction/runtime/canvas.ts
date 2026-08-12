import type { LandingRect } from './index'

export const MIND_CANVAS_SURFACE_ID = 'mind:canvas'
export const MIND_DRAWER_SURFACE_ID = 'mind:drawer'
export const MIND_CANVAS_OBJECT_TYPE = 'mind-canvas-object'
export const MIND_PROJECT_OBJECT_TYPE = 'mind-project-object'
export const MIND_CANVAS_OBJECT_TYPES = [MIND_CANVAS_OBJECT_TYPE, MIND_PROJECT_OBJECT_TYPE] as const

type LandingResolver = (destination: unknown) => LandingRect | null

const landingResolvers = new Map<string, LandingResolver>()

export function registerMindLandingResolver(objectId: string, resolver: LandingResolver): () => void {
  landingResolvers.set(objectId, resolver)
  return () => {
    if (landingResolvers.get(objectId) === resolver) landingResolvers.delete(objectId)
  }
}

export function resolveMindLandingRect(objectId: string, destination: unknown): LandingRect | null {
  return landingResolvers.get(objectId)?.(destination) ?? null
}
