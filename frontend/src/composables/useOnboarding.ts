// onboarding 状态的兼容编排入口：播种数据和弹窗引导各自维护自己的状态域。
import type { Router } from 'vue-router'
import { onboardingApi } from '@/services/api'

import { setOnboardingGuideState } from './useOnboardingGuide'
import { setOnboardingSeedState } from './useOnboardingSeed'

export { onboardingProjectId, onboardingSeedState } from './useOnboardingSeed'
export { onboardingGuideState, shouldShowOnboarding, updateOnboardingGuide, reopenOnboarding } from './useOnboardingGuide'

export async function runOnboarding(router: Router) {
  void router
  try {
    const response = await onboardingApi.getState() as {
      seed: Parameters<typeof setOnboardingSeedState>[0]
      guide: Parameters<typeof setOnboardingGuideState>[0]
    }
    setOnboardingSeedState(response.seed)
    setOnboardingGuideState(response.guide)
  } catch {
    // 状态读取失败不应阻塞主应用；下次登录或刷新会再次读取。
  }
}
