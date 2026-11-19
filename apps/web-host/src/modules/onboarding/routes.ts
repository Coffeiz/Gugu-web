import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { createOnboardingService, type OnboardingStore, resetOnboardingGuide } from '@gugu/core/onboarding'

export interface OnboardingRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  store: OnboardingStore
}

export function registerOnboardingRoutes(app: FastifyInstance, options: OnboardingRouteOptions): void {
  const onboarding = createOnboardingService(options.store)
  app.get('/api/v1/onboarding/state', { preHandler: options.requireUser }, (request) =>
    onboarding.get(options.ownerIdFromRequest(request)))

  app.patch('/api/v1/onboarding/state', { preHandler: options.requireUser }, (request) =>
    onboarding.update(options.ownerIdFromRequest(request), request.body))

  app.post('/api/v1/onboarding/state/reopen', { preHandler: options.requireUser }, (request) =>
    onboarding.reopen(options.ownerIdFromRequest(request)))
}

export interface OnboardingResetGuideOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  store: OnboardingStore
}

/** Python 此入口仅要求用户认证，无额外开发者权限；owner 由 Host 注入。 */
export function registerOnboardingResetGuideRoute(app: FastifyInstance, options: OnboardingResetGuideOptions): void {
  app.post('/api/v1/onboarding/dev/reset-guide', { preHandler: options.requireUser }, request =>
    resetOnboardingGuide(options.store, options.ownerIdFromRequest(request)))
}

export interface OnboardingReseedRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  reseed(ownerId: string): Promise<unknown>
}

/** Fastify 只注入认证 owner；清理、locale 与播种顺序由 Core 用例决定。 */
export function registerOnboardingReseedRoute(app: FastifyInstance, options: OnboardingReseedRouteOptions): void {
  app.post('/api/v1/onboarding/dev/reseed', { preHandler: options.requireUser }, request =>
    options.reseed(options.ownerIdFromRequest(request)))
}
