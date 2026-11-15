import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { resetOnboardingGuide, type OnboardingStore } from '@gugu/core/onboarding'

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
