import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

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
