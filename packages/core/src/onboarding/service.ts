import { GUIDE_VERSION, onboardingResponse, validateGuidePatch, type OnboardingStore } from './state.js'

/** 按可信所有者读取和更新引导进度。 */
export function createOnboardingService(store: OnboardingStore) {
  return {
    async get(ownerId: string) {
      return onboardingResponse(await store.getState(ownerId))
    },
    async update(ownerId: string, body: unknown) {
      const patch = validateGuidePatch(body)
      return onboardingResponse(await store.updateGuide(ownerId, patch))
    },
    async reopen(ownerId: string) {
      const state = await store.updateGuide(ownerId, {
        enabled: true,
        version: GUIDE_VERSION,
        dismissed: false,
        completed_at: null,
      })
      return onboardingResponse(state)
    },
  }
}
