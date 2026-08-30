// 对话框默认问候：进入「全新对话（无可恢复会话）」时后台生成一次（内存 ref，不跨刷新缓存）。
// 由 GuguChat onMounted 据 SESSION_KEY 决定——刷新停在老会话时不生成（问候那时根本不显示）。
// 打开对话框时以打字机动画显示；生成没好/失败 → 从兜底池随机取一条（兜底同样走打字机）。文案不自我介绍、不报菜单。
import { ref } from 'vue'
import { agentApi } from '@/services/api'
import { i18n } from '@/i18n'

function pickFallback() {
  const fallbacks = i18n.global.tm('greetingUi.fallbacks') as string[]
  return fallbacks[Math.floor(Math.random() * fallbacks.length)] || ''
}

// 生成好的问候（响应式，仅本次页面生命周期；刷新即重置 → 每次刷新重新生成）
export const greeting = ref('')

// 挂载时后台预取一次（fire-and-forget，不阻塞）
export async function prefetchGreeting() {
  try {
    if (greeting.value) return
    const { text } = await agentApi.greeting()
    const t = (text || '').trim()
    if (t) greeting.value = t
  } catch { /* 静默：取问候时走兜底 */ }
}

// 取问候：有生成版用生成版，否则随机兜底（永不空）
export function getGreeting() {
  return greeting.value || pickFallback()
}
