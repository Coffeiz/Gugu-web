import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { createOnboardingService, type OnboardingStore } from '@gugu/core/onboarding'

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
