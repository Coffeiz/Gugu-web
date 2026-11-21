// 注册播种的只读前端引用，不承载弹窗引导进度。
import { ref } from 'vue'

export type OnboardingSeedState = {
  seeded: boolean
  project_id: number | null
  project_name: string | null
}

export const onboardingProjectId = ref<number | null>(null)
export const onboardingSeedState = ref<OnboardingSeedState | null>(null)

export function setOnboardingSeedState(seed: OnboardingSeedState) {
  onboardingSeedState.value = seed
  onboardingProjectId.value = seed.project_id
}
