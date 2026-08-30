// 新用户初始化状态：保留播种项目本身，但不再主动展示任何引导气泡。
import { ref } from 'vue'
import type { Router } from 'vue-router'
import { onboardingApi } from '@/services/api'

// 播种的教程项目 id：供新建项目时排除它（教程项目的阶段不该成为新项目的默认模板）。
// runOnboarding 拉到 onboarding 状态时填入。
export const onboardingProjectId = ref<number | null>(null)

export async function runOnboarding(router: Router) {
  void router
  let state
  try { state = await onboardingApi.getState() } catch { return }
  if (!state) return
  onboardingProjectId.value = state.seeded_project_id ?? null   // 记下教程项目，新建项目时排除它
}
