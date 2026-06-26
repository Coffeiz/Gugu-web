// 新手引导前端启动：登录进入应用后，延迟弹「欢迎气泡」→「引导气泡」+ 高亮引导项目卡。
// 文案 / 随机 / once 都在后端（claim-once），前端只负责时机与展示。气泡复用通知 toast。
import { onboardingApi } from '@/services/api'
import { useUiStore } from '@/stores/ui'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function bubble(ui, text) {
  // gugu:true → 气泡文字用 GuguChat 聊天正文的大小/颜色
  if (text) ui.pushNotification({ title: '', content: text, bubble: true, persist: false, gugu: true })
}

// fire-and-forget；任何一步失败都静默（不打扰用户）
export async function runOnboarding(router) {
  const ui = useUiStore()
  let state
  try { state = await onboardingApi.getState() } catch { return }
  if (!state) return

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
