// 新手引导前端启动：登录进入应用后，延迟弹「欢迎气泡」→「引导气泡」+ 高亮引导项目卡。
// 文案 / 随机 / once 都在后端（claim-once），前端只负责时机与展示。气泡复用通知 toast。
import { ref } from 'vue'
import type { Router } from 'vue-router'
import { onboardingApi } from '@/services/api'
import { useUiStore } from '@/stores/ui'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// 播种的教程项目 id：供新建项目时排除它（教程项目的阶段不该成为新项目的默认模板）。
// runOnboarding 拉到 onboarding 状态时填入。
export const onboardingProjectId = ref<number | null>(null)

function bubble(ui: ReturnType<typeof useUiStore>, text?: string | null) {
  // gugu:true → 气泡文字用 GuguChat 聊天正文的大小/颜色
  if (text) ui.pushNotification({ title: '', content: text, bubble: true, persist: false, gugu: true })
}

// 情境气泡（07）：在各界面「第一次」事件处调。claim-once 在后端——每次事件都问、问到空就不弹，
// 前端无需记状态。key ∈ file_lib / music / calendar / stage_switch / todo_roam / todo_newproj / im_bind。
export async function fireHint(key: string) {
  await sleep(1000)   // 所有情境气泡延迟 1s 再弹，不在动作那一刻立刻冒
  try {
    const { text } = await onboardingApi.claim(`hint:${key}`)
    bubble(useUiStore(), text)
  } catch { /* 静默 */ }
}

// fire-and-forget；任何一步失败都静默（不打扰用户）
export async function runOnboarding(router: Router) {
  const ui = useUiStore()
  let state
  try { state = await onboardingApi.getState() } catch { return }
  if (!state) return
  onboardingProjectId.value = state.seeded_project_id ?? null   // 记下教程项目，新建项目时排除它
  if (!state.seeded) return   // 老用户（没走过新引导）：不弹欢迎/引导，后端 claim 也已加 seeded 闸

  let justWelcomed = false
  // 01 欢迎：打开后约 1s
  if (!state.welcome_shown) {
    await sleep(1000)
    try { bubble(ui, (await onboardingApi.claim('welcome')).text) } catch { return }
    justWelcomed = true
  }

  // 02 引导进项目 + 高亮引导项目卡（欢迎后隔几秒；老用户漏弹则尽快补）
  if (!state.guide_shown) {
    await sleep(justWelcomed ? 4500 : 1500)
    let g
    try { g = await onboardingApi.claim('guide') } catch { return }
    if (g?.text) {
      bubble(ui, g.text)
      if (state.seeded_project_id != null) {
        ui.pendingProjectHighlightMs = 5000       // 引导高亮停留 5s
        ui.pendingProjectHighlightBreath = true   // 一次「呼吸」效果（先设这俩，再设 id 触发）
        ui.pendingProjectHighlight = state.seeded_project_id
        if (router.currentRoute.value.path !== '/projects') router.push('/projects')
      }
    }
  }
}
