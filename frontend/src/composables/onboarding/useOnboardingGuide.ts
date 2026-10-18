// 弹窗功能引导状态；播种内容只作为它的只读展示数据来源。
import { computed, ref } from 'vue'
import { onboardingApi } from '@/services/api'
import { createOnboardingProgressSaver } from './progressSaver'

export type OnboardingGuideState = {
  enabled: boolean
  version: number
  current_step: string
  completed_steps: string[]
  dismissed: boolean
  completed_at: string | null
  should_show?: boolean
}

export const onboardingGuideState = ref<OnboardingGuideState | null>(null)
export const shouldShowOnboarding = computed(() => onboardingGuideState.value?.should_show === true)

const progressSaver = createOnboardingProgressSaver(
  patch => onboardingApi.updateState(patch) as Promise<{ guide: OnboardingGuideState }>,
  response => {
    const guide = (response as { guide?: OnboardingGuideState } | null)?.guide
    if (guide) setOnboardingGuideState(guide)
  },
)

export function setOnboardingGuideState(guide: OnboardingGuideState) {
  onboardingGuideState.value = guide
}

export async function updateOnboardingGuide(patch: Record<string, unknown>) {
  await progressSaver.flush()
  const response = await onboardingApi.updateState(patch) as { guide: OnboardingGuideState }
  setOnboardingGuideState(response.guide)
  return response
}

export function queueOnboardingGuideProgress(patch: Record<string, unknown>) {
  progressSaver.enqueue(patch)
}

export async function flushOnboardingGuideProgress(patch?: Record<string, unknown>) {
  return await progressSaver.flush(patch) as { guide: OnboardingGuideState } | undefined
}

export async function reopenOnboarding() {
  const response = await onboardingApi.reopen() as { guide: OnboardingGuideState }
  setOnboardingGuideState(response.guide)
  return response
}
