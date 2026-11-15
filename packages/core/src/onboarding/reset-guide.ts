import { GUIDE_VERSION, onboardingResponse, type OnboardingStore } from './state.js'

/** 清空当前所有者的引导进度；播种内容及既有扩展字段由原子状态更新保留。 */
export async function resetOnboardingGuide(store: OnboardingStore, ownerId: string) {
  const state = await store.updateGuide(ownerId, {
    enabled: true,
    version: GUIDE_VERSION,
    current_step: 'locale',
    completed_steps: [],
    dismissed: false,
    completed_at: null,
  })
  return { ok: true, state: onboardingResponse(state) }
}
