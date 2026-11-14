import { CoreError } from '@gugu/core'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'

export const GUIDE_VERSION = 1
export const GUIDE_STEPS = ['locale', 'features', 'style', 'model', 'im', 'complete'] as const
type GuideStep = typeof GUIDE_STEPS[number]

export interface OnboardingStore {
  getState(ownerId: string): Promise<Record<string, unknown>>
  updateGuide(ownerId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface OnboardingRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  store: OnboardingStore
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function defaults() {
  return {
    seed: { seeded: false, project_id: null, project_name: null },
    guide: {
      enabled: false,
      version: GUIDE_VERSION,
      current_step: 'locale',
      completed_steps: [] as string[],
      dismissed: false,
      completed_at: null as string | null,
    },
  }
}

function normalizeGuide(value: unknown): Record<string, unknown> {
  const source = record(value)
  const versionValue = Number(source.version ?? GUIDE_VERSION)
  const version = Number.isFinite(versionValue) ? Math.max(1, Math.trunc(versionValue)) : GUIDE_VERSION
  const rawSteps = Array.isArray(source.completed_steps) ? source.completed_steps : []
  return {
    ...defaults().guide,
    ...source,
    version,
    current_step: GUIDE_STEPS.includes(source.current_step as GuideStep) ? source.current_step : 'locale',
    completed_steps: [...new Set(rawSteps.filter((step): step is GuideStep =>
      typeof step === 'string' && GUIDE_STEPS.includes(step as GuideStep)))],
    enabled: Boolean(source.enabled),
    dismissed: Boolean(source.dismissed),
  }
}

export function normalizeOnboardingState(value: unknown): Record<string, unknown> {
  const source = record(value)
  if ('seed' in source || 'guide' in source) {
    const base = defaults()
    return {
      ...base,
      ...source,
      seed: { ...base.seed, ...record(source.seed) },
      guide: normalizeGuide(source.guide),
    }
  }

  // Preserve legacy seed fields without automatically enabling the modal guide.
  const { seeded, seeded_project_id, seeded_project_name, ...other } = source
  const base = defaults()
  return {
    ...base,
    ...other,
    seed: {
      ...base.seed,
      ...(seeded === undefined ? {} : { seeded }),
      ...(seeded_project_id === undefined ? {} : { project_id: seeded_project_id }),
      ...(seeded_project_name === undefined ? {} : { project_name: seeded_project_name }),
    },
  }
}

function shouldShow(value: Record<string, unknown>): boolean {
  return Boolean(value.enabled)
    && !value.dismissed
    && !value.completed_at
    && value.version === GUIDE_VERSION
}

export function onboardingResponse(value: unknown): Record<string, unknown> {
  const normalized = normalizeOnboardingState(value)
  const guide = normalizeGuide(normalized.guide)
  const visible = shouldShow(guide)
  return {
    ...normalized,
    guide: { ...guide, should_show: visible },
    should_show: visible,
  }
}

function invalidGuideField(message: string): never {
  throw new CoreError('invalid_request', message)
}

function validateCurrentStep(value: unknown): void {
  if (value !== undefined && !GUIDE_STEPS.includes(value as GuideStep)) invalidGuideField('引导步骤无效')
}

function validateCompletedSteps(value: unknown): GuideStep[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((step) => typeof step !== 'string' || !GUIDE_STEPS.includes(step as GuideStep)))
    invalidGuideField('已完成引导步骤无效')
  return [...new Set(value as GuideStep[])]
}

function validateGuideVersion(value: unknown): number {
  if (value === null) return invalidGuideField('引导版本无效')
  const version = typeof value === 'number' && Number.isInteger(value)
    ? value
    : typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isSafeInteger(version) || version < 1) invalidGuideField('引导版本无效')
  return version
}

export function validateGuidePatch(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalidGuideField('引导状态请求无效')
  const value = record(body)
  const allowed = new Set(['current_step', 'completed_steps', 'dismissed', 'completed_at', 'guide_version'])
  if (Object.keys(value).some((key) => !allowed.has(key)))
    invalidGuideField('引导状态包含不允许的字段')

  validateCurrentStep(value.current_step)
  const completedSteps = validateCompletedSteps(value.completed_steps)
  if (value.dismissed !== undefined && typeof value.dismissed !== 'boolean')
    invalidGuideField('dismissed 必须是布尔值')
  if (value.completed_at !== undefined && value.completed_at !== null && typeof value.completed_at !== 'string')
    invalidGuideField('completed_at 无效')

  const patch = { ...value }
  if (completedSteps !== undefined) patch.completed_steps = completedSteps
  if ('guide_version' in value) {
    patch.version = validateGuideVersion(value.guide_version)
    delete patch.guide_version
  }
  if (patch.completed_at === null) delete patch.completed_at
  return patch
}

export function registerOnboardingRoutes(app: FastifyInstance, options: OnboardingRouteOptions): void {
  app.get('/api/v1/onboarding/state', { preHandler: options.requireUser }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    return onboardingResponse(await options.store.getState(ownerId))
  })

  app.patch('/api/v1/onboarding/state', { preHandler: options.requireUser }, async (request) => {
    const patch = validateGuidePatch(request.body)
    const ownerId = options.ownerIdFromRequest(request)
    return onboardingResponse(await options.store.updateGuide(ownerId, patch))
  })

  app.post('/api/v1/onboarding/state/reopen', { preHandler: options.requireUser }, async (request) => {
    const ownerId = options.ownerIdFromRequest(request)
    const state = await options.store.updateGuide(ownerId, {
      version: GUIDE_VERSION,
      dismissed: false,
      completed_at: null,
    })
    return onboardingResponse(state)
  })
}
